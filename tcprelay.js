const net = require('net');
const log4js = require('log4js');
const WebSocket = require('ws');
const Encryptor = require('shadowsocks/lib/shadowsocks/encrypt').Encryptor;

const MAX_CONNECTIONS = 50000;

const TCP_RELAY_TYPE_LOCAL = 1;
const TCP_RELAY_TYPE_SERVER = 2;

const ADDRESS_TYPE_IPV4 = 0x01;
const ADDRESS_TYPE_DOMAIN_NAME = 0x03;
const ADDRESS_TYPE_IPV6 = 0x04;
const ADDRESS_TYPE = {
	1: 'IPV4',
	3: 'DOMAIN_NAME',
	4: 'IPV6'
};

const VERSION = 0x05;

const METHOD_NO_AUTHENTICATION_REQUIRED = 0x00;
const METHOD_GSSAPI = 0x01;
const METHOD_USERNAME_PASSWORD = 0x02;
const METHOD_NO_ACCEPTABLE_METHODS = 0xff;

const CMD_CONNECT = 0x01;
const CMD_BIND = 0x02;
const CMD_UDP_ASSOCIATE = 0x03;
const CMD = {
	1: 'CONNECT',
	2: 'BIND',
	3: 'UDP_ASSOCIATE'
};

const REPLIE_SUCCEEDED = 0x00;
const REPLIE_GENERAL_SOCKS_SERVER_FAILURE = 0x01;
const REPLIE_CONNECTION_NOT_ALLOWED_BY_RULESET = 0x02;
const REPLIE_NETWORK_UNREACHABLE = 0x03;
const REPLIE_HOST_UNREACHABLE = 0x04;
const REPLIE_CONNECTION_REFUSED = 0x05;
const REPLIE_TTL_EXPIRED = 0x06;
const REPLIE_COMMAND_NOT_SUPPORTED = 0x07;
const REPLIE_ADDRESS_TYPE_NOT_SUPPORTED = 0x08;

const STAGE_INIT = 0;
const STAGE_ADDR = 1;
const STAGE_UDP_ASSOC = 2;
const STAGE_DNS = 3;
const STAGE_CONNECTING = 4;
const STAGE_STREAM = 5;
const STAGE_DESTROYED = -1;

const STAGE = {
	[-1]: 'STAGE_DESTROYED',
	0: 'STAGE_INIT',
	1: 'STAGE_ADDR',
	2: 'STAGE_UDP_ASSOC',
	3: 'STAGE_DNS',
	4: 'STAGE_CONNECTING',
	5: 'STAGE_STREAM'
};

var globalConnectionId = 1;

function parseAddressHeader(data, offset) {
	var addressType = data.readUInt8(offset);
	var headerLen, dstAddr, dstPort, dstAddrLen;
	if (addressType == ADDRESS_TYPE_DOMAIN_NAME) {
		dstAddrLen = data.readUInt8(offset + 1);
		dstAddr = data.slice(offset + 2, offset + 2 + dstAddrLen).toString();
		dstPort = data.readUInt16BE(offset + 2 + dstAddrLen);
		headerLen = 4 + dstAddrLen;
	}
	//ipv4
	else if (addressType == ADDRESS_TYPE_IPV4) {
		dstAddr = data.slice(offset + 1, offset + 5).join('.').toString();
		dstPort = data.readUInt16BE(offset + 5);
		headerLen = 7;
	} else {
		return false;
	}
	return {
		addressType: addressType,
		headerLen: headerLen,
		dstAddr: dstAddr,
		dstPort: dstPort
	};
}

// client <=> local <=> server <=> target
function TCPRelay(config, isLocal, logLevel) {
	this.isLocal = isLocal;
	this.server = null;
	this.config = require('./config.json');
	if (config) {
		this.config = Object.assign(this.config, config);
	}
	this.logger = log4js.getLogger(isLocal ? 'sslocal' : 'ssserver');
	this.logger.setLevel(logLevel ? logLevel : 'error');
}


TCPRelay.prototype.getServerName = function() {
	return this.isLocal ? 'sslocal' : 'ssserver';
};


TCPRelay.prototype.bootstrap = function() {
	this.init();
};

TCPRelay.prototype.init = function() {
	var self = this;
	var config = self.config;
	var port = self.isLocal ? config.localPort : config.serverPort;
	var address = self.isLocal ? config.localAddress : config.serverAddress;
	var server;

	if (self.isLocal) {
		server = self.server = net.createServer({
			allowHalfOpen: true,
		});
		server.maxConnections = MAX_CONNECTIONS;
		server.on('connection', function(connection) {
			return self.handleConnectionByLocal(connection);
		});
		server.listen(port, address);
	} else {
		server = self.server = new WebSocket.Server({
			host: address,
			port: port,
			verifyClient: false
		});
		server.on('connection', function(connection) {
			return self.handleConnectionByServer(connection);
		});
	}
	server.on('error', function(error) {
		self.logger.error('an error of', self.getServerName(), 'occured', error);
	});
	server.on('listening', function() {
		self.logger.info(self.getServerName(), 'is listening on', address + ':' + port);
	});
};

//server
TCPRelay.prototype.handleConnectionByServer = function(connection) {
	var self = this;
	var config = self.config;
	var method = config.method;
	var password = config.password;
	var serverAddress = config.serverAddress;
	var serverPort = config.serverPort;

	var logger = self.logger;
	var encryptor = new Encryptor(password, method);

	var stage = STAGE_INIT;
	var connectionId = (globalConnectionId++) % MAX_CONNECTIONS;
	var targetConnection, addressHeader;

	var canWriteToLocalConnection = true;

	logger.info(`accept connection from local[${connectionId}]`);
	connection.on('message', function(data) {
		data = encryptor.decrypt(data);
		logger.info(`read data[length = ${data.length}] from local connection[${connectionId}] at stage[${STAGE[stage]}]`);

		switch (stage) {

			case STAGE_INIT:
				if (data.length < 7) {
					stage = STAGE_DESTROYED;
					return connection.close();
				}
				addressHeader = parseAddressHeader(data, 0);
				if (!addressHeader) {
					stage = STAGE_DESTROYED;
					return connection.close();
				}

				logger.info(`connecting to ${addressHeader.dstAddr}:${addressHeader.dstPort}`);
				stage = STAGE_CONNECTING;
				connection.pause();

				targetConnection = net.createConnection({
					port: addressHeader.dstPort,
					host: addressHeader.dstAddr,
					allowHalfOpen: true
				}, function() {
					logger.info(`connecting to target[${connectionId}]`);
					connection.resume();
					stage = STAGE_STREAM;
				});

				targetConnection.on('data', function(data) {
					logger.info(`read data[length = ${data.length}] from target connection[${connectionId}]`);
					canWriteToLocalConnection && connection.send(encryptor.encrypt(data), {
						binary: true
					}, function() {
						logger.info(`write data[length = ${data.length}] to local connection[${connectionId}]`);
					});
				});
				targetConnection.setKeepAlive(true, 5000);
				targetConnection.on('end', function() {
					connection.close();
				});
				targetConnection.on('error', function(error) {
					logger.error(`an error of target connection[${connectionId}] occured`, error);
					stage = STAGE_DESTROYED;
					targetConnection.destroy();
					connection.close();
				});

				if (data.length > addressHeader.headerLen) {
					connection.pause();
					targetConnection.write(data.slice(addressHeader.headerLen), function() {
						connection.resume();
					});
				}
				break;

			case STAGE_STREAM:
				connection.pause();
				canWriteToLocalConnection && targetConnection.write(data, function() {
					logger.info(`write data[length = ${data.length}] to target connection[${connectionId}]`);
					connection.resume();
				});
				break;
		}
	});
	connection.on('close', function(hadError) {
		logger.info(`close event[had error = ${hadError}] of connection[${connectionId}] has been triggered`);
		canWriteToLocalConnection = false;
	});
	connection.on('error', function(error) {
		logger.error(`an error of connection[${connectionId}] occured`, error);
		connection.terminate();
		canWriteToLocalConnection = false;
		targetConnection && targetConnection.end();
	});
}



//local
TCPRelay.prototype.handleConnectionByLocal = function(connection) {
	var self = this;
	var config = self.config;
	var method = config.method;
	var password = config.password;
	var serverAddress = config.serverAddress;
	var serverPort = config.serverPort;

	var logger = self.logger;
	var encryptor = new Encryptor(password, method);

	var stage = STAGE_INIT;
	var connectionId = (globalConnectionId++) % MAX_CONNECTIONS;
	var serverConnection, cmd, addressHeader;

	var canWriteToLocalConnection = true;

	logger.info(`accept connection from client[${connectionId}]`);
	connection.setKeepAlive(true, 10000);
	connection.on('data', function(data) {
		logger.info(`read data[length = ${data.length}] from client connection[${connectionId}] at stage[${STAGE[stage]}]`);
		switch (stage) {

			case STAGE_INIT:
				if (data.length < 3 || data.readUInt8(0) != 5) {
					stage = STAGE_DESTROYED;
					return connection.end();
				}
				connection.write("\x05\x00");
				stage = STAGE_ADDR;
				break;

			case STAGE_ADDR:
				if (data.length < 10 || data.readUInt8(0) != 5) {
					stage = STAGE_DESTROYED;
					return connection.end();
				}
				cmd = data.readUInt8(1);
				addressHeader = parseAddressHeader(data, 3);
				if (!addressHeader) {
					stage = STAGE_DESTROYED;
					return connection.end();
				}

				//only supports connect cmd
				if (cmd != CMD_CONNECT) {
					logger.error('only supports connect cmd');
					stage = STAGE_DESTROYED;
					return connection.end("\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00");
				}

				logger.info(`connecting to ${addressHeader.dstAddr}:${addressHeader.dstPort}`);
				connection.write("\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00");

				stage = STAGE_CONNECTING;
				connection.pause();

				serverConnection = new WebSocket('ws://' + serverAddress + ':' + serverPort, {
					perMessageDeflate: false
				});
				serverConnection.on('open', function() {
					logger.info(`connecting to websocket server[${connectionId}]`);
					serverConnection.send(encryptor.encrypt(data.slice(3)), function() {
						stage = STAGE_STREAM;
						connection.resume();
					});
				});
				serverConnection.on('message', function(data) {
					logger.info(`read data[length = ${data.length}] from websocket server connection[${connectionId}]`);
					canWriteToLocalConnection && connection.write(encryptor.decrypt(data), function() {
						logger.info(`write data[length = ${data.length}] to client connection[${connectionId}]`);
					});
				});
				serverConnection.on('error', function(error) {
					logger.error(`an error of server connection[${connectionId}] occured`, error);
					stage = STAGE_DESTROYED;
					connection.end();
				});
				serverConnection.on('close', function() {
					stage = STAGE_DESTROYED;
					connection.end();
				});
				break;

			case STAGE_STREAM:
				connection.pause();
				canWriteToLocalConnection && serverConnection.send(encryptor.encrypt(data), {
					binary: true
				}, function() {
					logger.info(`write data[length = ${data.length}] to websocket server connection[${connectionId}]`);
					connection.resume();
				});
				break;
		}
	});
	connection.on('end', function() {
		stage = STAGE_DESTROYED;
		logger.info(`end event of client connection[$connectionId] has been triggered`);
	});
	connection.on('close', function(hadError) {
		logger.info(`close event[had error = ${hadError}] of client connection[${connectionId}] has been triggered`);
		stage = STAGE_DESTROYED;
		canWriteToLocalConnection = false;
	});
	connection.on('error', function(error) {
		logger.error(`an error of client connection[${connectionId}] occured`, error);
		stage = STAGE_DESTROYED;
		connection.destroy();
		canWriteToLocalConnection = false;
		serverConnection && serverConnection.close();
	});
}

module.exports.TCPRelay = TCPRelay;