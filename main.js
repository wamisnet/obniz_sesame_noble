const crypto = require('crypto');
const Peripheral = require("obniz-noble/lib/peripheral");
const noble = require("obniz-noble")("OBNIZ_ID_");
const events = require('events');
const os = require('os');
const log4js = require('log4js');
const logger = log4js.getLogger();
logger.level = 'debug';

// config block start
const userId = 'Sesameログインメールアドレス';
const password = 'Sesameアプリから取得したHmacSHA256';

// 下記はoption。指定したほうがscanがskipできるため早くなる。
// Scanで取得する
const deviceId = 'スキャンで見つけたID';//ff00ff00ff00
const address = 'Macアドレス';//ff:00:ff:00:ff:00
const manufacturerDataMacData = []; // [0x00,0x00...]のように配列で指定する
// config block end

const CODE_LOCK = 1;
const CODE_UNLOCK = 2;
const serviceOperationUuid = '000015231212efde1523785feabcd123';
const characteristicCommandUuid = '000015241212efde1523785feabcd123';
const characteristicStatusUuid = '000015261212efde1523785feabcd123';
const characteristicAngleStatusUuid = '000015251212efde1523785feabcd123';
// 接続後ロック系コマンドを打たないと10秒で切断される。
// ロック系コマンド実行から1分で切断される。
logger.info('==> waiting on adapter state change');

let status;
let cmd;
let angleStatus;
let peripheral;
let lockStatus = null;

const event = new events.EventEmitter;

noble.on('stateChange', (state) => {
    logger.info('==> adapter state change', state);
    if (state === 'poweredOn') {
        if (address === '') {
            // scanする場合
            logger.info('==> start scanning', [serviceOperationUuid]);
            //noble.startScanning([], true); // 都度advertisementパケット届き次第結果がでるが、余計なのがでたりうまく動かなかった。但し各BLE機器の送出間隔がわかるので一度見るのもよいかも。
            noble.startScanning();
        } else {
            // 直接接続する場合
            connectSesame();
        }
    } else {
        noble.stopScanning();
    }
});

noble.on('discover', (peripheral) => {
    if (peripheral.id !== deviceId) {
        //logger.info(`BLE Device Found: ${peripheral.advertisement.localName}(${peripheral.uuid}) RSSI${peripheral.rssi}`);
        logger.info('peripheral discovered; id mismatch. peripheral.id:', peripheral.id, "localName:", peripheral.advertisement.localName, "address:", peripheral.address, "addressType:", peripheral.addressType);
        //logger.info(peripheral);
    } else {
        logger.info('ok. peripheral discovered; id match. peripheral.id:', peripheral.id, "localName:", peripheral.advertisement.localName, "address:", peripheral.address, "addressType:", peripheral.addressType, "manufacturerData:", peripheral.advertisement.manufacturerData);
        //logger.info(peripheral);
        noble.stopScanning();
        connect(peripheral);
    }
});

function connectSesame() {
    advertisement = {
        manufacturerData: Buffer.from(manufacturerDataMacData),
        serviceUuids: ['1523']
    }
    //peripheral = new Peripheral(noble, deviceId, address, addressType, connectable, advertisement, rssi);
    peripheral = new Peripheral(noble, deviceId, address, 'random', true, advertisement, -84);
    noble._peripherals[deviceId] = peripheral;
    noble._services[deviceId] = {};
    noble._characteristics[deviceId] = {};
    noble._descriptors[deviceId] = {};

    if (os.platform() !== 'darwin') {
        // linuxの場合は下記も必要とのことでした。thx! warpzoneさん
        noble._bindings._addresses[deviceId] = address;
        noble._bindings._addresseTypes[deviceId] = 'random';
    }

    connect(peripheral);
}

function disconnect() {
    peripheral = new Peripheral(noble, deviceId, address, 'random', true, advertisement, -84);
    noble._peripherals[deviceId] = peripheral;
    noble._services[deviceId] = {};
    noble._characteristics[deviceId] = {};
    noble._descriptors[deviceId] = {};

    peripheral.disconnect((error)=>{
        if (error) {
            logger.info('==> Failed to disconnect:', error);
        } else {
            logger.info('==> disconnected');
        }
    });
}

function connect(peripheral) {
    //logger.info('==> connecting to', peripheral.id);
    logger.info('==> connecting start');
    peripheral.connect((error) => {
        if (error) {
            logger.info('==> Failed to connect:', error);
        } else {
            logger.info('==> connected');
            discoverService(peripheral);
        }
    });

    peripheral.once('disconnect', function() {
        logger.info('==> disconnect');
    });
}

function discoverService(peripheral) {
    logger.info('==> discovering services');
    peripheral.once('servicesDiscover', (services) => {
        //services.map((s) => logger.info("uuid:"+s.uuid));

        const opServices = services.filter((s) => s.uuid === serviceOperationUuid);
        if (opServices.length !== 1) {
            throw new Error('unexpected number of operation services');
        }

        discoverCharacteristic(peripheral, opServices[0]);
    });
    peripheral.discoverServices();
}

function discoverCharacteristic(peripheralLocal, opService) {
    logger.info('==> discovering characteristics');
    opService.once('characteristicsDiscover', (characteristics) => {
        const charStatus = characteristics.filter((c) => c.uuid === characteristicStatusUuid);
        const charCmd = characteristics.filter((c) => c.uuid === characteristicCommandUuid);
        const charAngleStatus = characteristics.filter((c) => c.uuid === characteristicAngleStatusUuid);

        if (charStatus.length !== 1 || charCmd.length !== 1 || charAngleStatus.length !== 1) {
            throw new Error('unexpected number of command/status/angleStatus characteristics');
        }
        characteristics.map((c) => logger.info("info uuid:"+c.uuid));

        characteristics.map((c) => {
            if (c.uuid === characteristicStatusUuid
                || c.uuid === characteristicCommandUuid
                || c.uuid === characteristicAngleStatusUuid)
            {
                return
            }
            c.on('data', (data) => {
                logger.info("unknown uuid:"+c.uuid);
                logger.info(data);
            });
            c.subscribe();
        });

        status = charStatus[0];
        cmd = charCmd[0];
        angleStatus = charAngleStatus[0];
        peripheral = peripheralLocal;

        angleStatus.on('data', (data) => {
            const angleRaw = data.slice(2, 4).readUInt16LE(0);
            const angle = Math.floor((angleRaw/1024*360));

            logger.info("angle: ", data, "angle:"+angle);

            event.emit('lock_status_set');

        });
        angleStatus.subscribe();

        status.on('data', (data) => {
            const sn = data.slice(6, 10).readUInt32LE(0) + 1;
            const err = data.slice(14).readUInt8();
            const errMsg = [
                "Timeout",
                "Unsupported",
                "Success",
                "Operating",
                "ErrorDeviceMac",
                "ErrorUserId",
                "ErrorNumber",
                "ErrorSignature",
                "ErrorLevel",
                "ErrorPermission",
                "ErrorLength",
                "ErrorUnknownCmd",
                "ErrorBusy",
                "ErrorEncryption",
                "ErrorFormat",
                "ErrorBattery",
                "ErrorNotSend"
            ];
            logger.info('status update', data, '[sn=', + sn + ', err=' + errMsg[err+1] + ']');
        });
        status.subscribe();

        // lock(0)だとErrorUnknownCmdになるが、認証することで現在の角度がわかるため実行する
        lock(0); // 0だとErrorUnknownCmd。3だとErrorLength。4だとErrorUnknownCmd。3は何かできそう。

        // 起動時にtoggleしてlock, unlockする場合は下記をコメントアウト
        // event.once('lock_status_set', () => {
        //   lock(lockStatus ? CODE_UNLOCK : CODE_LOCK);
        // });
    });
    opService.discoverCharacteristics();
}

function lock(cmdValue) {
    logger.info('==> reading serial number');
    status.read((error, data) => {
        if (error) { logger.info(error); process.exit(-1); }
        if (data) {
            const macData = peripheral.advertisement.manufacturerData;
            const sn = data.slice(6, 10).readUInt32LE(0) + 1;
            const payload = _sign(cmdValue, '', password, macData.slice(3), userId, sn);
            let cmdName;
            if (cmdValue === CODE_LOCK) {
                cmdName = "cmdValue:lock";
            } else if (cmdValue === CODE_UNLOCK) {
                cmdName = "cmdValue:unlock";
            } else {
                cmdName = "cmdValue:"+cmdValue;
            }
            logger.info('==> ', cmdName, sn);
            write(cmd, payload);
        }
    });
}

function _sign(code, payload, password, macData, userId, nonce) {
    logger.info("macData: ", macData);
    logger.info("pass: ", Buffer.from(password, 'hex'));
    const hmac = crypto.createHmac('sha256', Buffer.from(password, 'hex'));
    const hash = crypto.createHash('md5');
    hash.update(userId);
    const buf = Buffer.alloc(payload.length + 59);
    macData.copy(buf, 32); // len = 6
    const md5 = hash.digest();
    md5.copy(buf, 38); // len = 16
    logger.info('md5: ', md5);
    buf.writeUInt32LE(nonce, 54); // len = 4
    buf.writeUInt8(code, 58); // len = 1
    Buffer.from(payload).copy(buf, 59);
    hmac.update(buf.slice(32));
    hmac.digest().copy(buf, 0);
    logger.info('buf: ', buf);
    logger.info('buf: ', buf.toString("hex"));

    return buf;
}

function write(char, payload) {
    const writes = [];
    for(let i=0;i<payload.length;i+=19) {
        const sz = Math.min(payload.length - i, 19);
        const buf = Buffer.alloc(sz + 1);
        if (sz < 19) {
            buf.writeUInt8(4, 0);
        } else if (i === 0) {
            buf.writeUInt8(1, 0);
        } else {
            buf.writeUInt8(2, 0);
        }

        payload.copy(buf, 1, i, i + 19);
        logger.info('<== writing:', buf.toString('hex').toUpperCase());
        char.write(buf, false);
    }
}

const rl = require('readline')
const rli = rl.createInterface(process.stdin, process.stdout)
rli.on('line', function(line) {
    logger.info(line);
    if (line === 'l') {
        lock(CODE_LOCK);
    } else if (line === 'u') {
        lock(CODE_UNLOCK);
    } else if (line === 't') {
        lock(lockStatus ? CODE_UNLOCK : CODE_LOCK);
    } else if (line === 'c') {
        connectSesame();
    }else if(line === 'd'){
        disconnect();
    }
    rli.prompt();
}).on('close', function() {
    logger.info('close');
    process.stdin.destroy();
});
rli.prompt();
