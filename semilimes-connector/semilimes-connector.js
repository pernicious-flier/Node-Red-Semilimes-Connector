/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    "use strict";
    var ws = require("ws");
    var inspect = require("util").inspect;
    var url = require("url");
    var HttpsProxyAgent = require('https-proxy-agent');


    var serverUpgradeAdded = false;
    function handleServerUpgrade(request, socket, head) {
        const pathname = url.parse(request.url).pathname;
        if (listenerNodes.hasOwnProperty(pathname)) {
            listenerNodes[pathname].server.handleUpgrade(request, socket, head, function done(ws) {
                listenerNodes[pathname].server.emit('connection', ws, request);
            });
        } else {
            // Don't destroy the socket as other listeners may want to handle the
            // event.
        }
    }
    var listenerNodes = {};
    var activeListenerNodes = 0;


    // A node red node that sets up a local websocket server
    function WebSocketListenerNode(n) {
        // Create a RED node
        RED.nodes.createNode(this,n);
        var node = this;
		
		//node.receiver = "aa4eccdf-7868-4e0f-92f6-5a90a4e251b0";		

        // Store local copies of the node configuration (as defined in the .html)
        node.path = n.path;
        node.wholemsg = (n.wholemsg === "true");

        node._inputNodes = [];    // collection of nodes that want to receive events
        node._clients = {};
        // match absolute url
        node.isServer = !/^ws{1,2}:\/\//i.test(node.path);
        node.closing = false;
        node.tls = n.tls;

        function startconn() {    // Connect to remote endpoint
            node.tout = null;
            var prox, noprox;
            if (process.env.http_proxy) { prox = process.env.http_proxy; }
            if (process.env.HTTP_PROXY) { prox = process.env.HTTP_PROXY; }
            if (process.env.no_proxy) { noprox = process.env.no_proxy.split(","); }
            if (process.env.NO_PROXY) { noprox = process.env.NO_PROXY.split(","); }
            
            var noproxy = false;
            if (noprox) {
                for (var i in noprox) {
                    if (node.path.indexOf(noprox[i].trim()) !== -1) { noproxy=true; }
                }
            }
            
            var agent = undefined;
            if (prox && !noproxy) {
                agent = new HttpsProxyAgent(prox);
            }

            var options = {};
            if (agent) {
                options.agent = agent;
            }
            if (node.tls) {
                var tlsNode = RED.nodes.getNode(node.tls);
                if (tlsNode) {
                    tlsNode.addTLSOptions(options);
                }
            }
            var socket = new ws(node.path,options);
            socket.setMaxListeners(0);
            node.server = socket; // keep for closing
            handleConnection(socket);
        }

        function handleConnection(/*socket*/socket) {
            var id = (1+Math.random()*4294967295).toString(16);
            if (node.isServer) {
                node._clients[id] = socket;
                node.emit('opened',{count:Object.keys(node._clients).length,id:id});
            }
            socket.on('open',function() {
                if (!node.isServer) {
                    node.emit('opened',{count:'',id:id});
                }
            });
            socket.on('close',function() {
                if (node.isServer) {
                    delete node._clients[id];
                    node.emit('closed',{count:Object.keys(node._clients).length,id:id});
                } else {
                    node.emit('closed',{count:'',id:id});
                }
                if (!node.closing && !node.isServer) {
                    clearTimeout(node.tout);
                    node.tout = setTimeout(function() { startconn(); }, 3000); // try to reconnect every 3 secs... bit fast ?
                }
            });
            socket.on('message',function(data,flags) {
                node.handleEvent(id,socket,'message',data,flags);
            });
            socket.on('error', function(err) {
                node.emit('erro',{err:err,id:id});
                if (!node.closing && !node.isServer) {
                    clearTimeout(node.tout);
                    node.tout = setTimeout(function() { startconn(); }, 3000); // try to reconnect every 3 secs... bit fast ?
                }
            });
        }

        if (node.isServer) {
            activeListenerNodes++;
            if (!serverUpgradeAdded) {
                RED.server.on('upgrade', handleServerUpgrade);
                serverUpgradeAdded = true
            }

            var path = RED.settings.httpNodeRoot || "/";
            path = path + (path.slice(-1) == "/" ? "":"/") + (node.path.charAt(0) == "/" ? node.path.substring(1) : node.path);
            node.fullPath = path;

            if (listenerNodes.hasOwnProperty(path)) {
                node.error(RED._("websocket.errors.duplicate-path",{path: node.path}));
                return;
            }
            listenerNodes[node.fullPath] = node;
            var serverOptions = {
                noServer: true
            }
            if (RED.settings.webSocketNodeVerifyClient) {
                serverOptions.verifyClient = RED.settings.webSocketNodeVerifyClient;
            }
            // Create a WebSocket Server
            node.server = new ws.Server(serverOptions);
            node.server.setMaxListeners(0);
            node.server.on('connection', handleConnection);
        }
        else {
            node.closing = false;
            startconn(); // start outbound connection
        }

        node.on("close", function() {
            if (node.isServer) {
                delete listenerNodes[node.fullPath];
                node.server.close();
                node._inputNodes = [];
                activeListenerNodes--;
                // if (activeListenerNodes === 0 && serverUpgradeAdded) {
                //     RED.server.removeListener('upgrade', handleServerUpgrade);
                //     serverUpgradeAdded = false;
                // }


            }
            else {
                node.closing = true;
                node.server.close();
                if (node.tout) {
                    clearTimeout(node.tout);
                    node.tout = null;
                }
            }
        });
    }
    RED.nodes.registerType("semilimes-listener",WebSocketListenerNode);
    RED.nodes.registerType("semilimes-client",WebSocketListenerNode);

    WebSocketListenerNode.prototype.registerInputNode = function(/*Node*/handler) {
        this._inputNodes.push(handler);
    }

    WebSocketListenerNode.prototype.removeInputNode = function(/*Node*/handler) {
        this._inputNodes.forEach(function(node, i, inputNodes) {
            if (node === handler) {
                inputNodes.splice(i, 1);
            }
        });
    }

    WebSocketListenerNode.prototype.handleEvent = function(id,/*socket*/socket,/*String*/event,/*Object*/data,/*Object*/flags) {
        var msg,obj;
        if (this.wholemsg) {
            try {
                msg = JSON.parse(data);
                if (typeof msg !== "object" && !Array.isArray(msg) && (msg !== null)) {
                    msg = { payload:msg };
                }
            }
            catch(err) {
                msg = { payload:data };
            }
        } else {
            msg = {
                payload:data
            };
        }
        msg._session = {type:"websocket",id:id};
		obj = JSON.parse(msg.payload);
		try {
			for (var i = 0; i < this._inputNodes.length; i++) 
			{
				if(obj.ConversationID == this._inputNodes[i].rxfilter)
				{
					this._inputNodes[i].send(msg);
				}
			}
		}
		catch(err) {}
    }
	WebSocketListenerNode.prototype.broadcast = function(data) {
        if (this.isServer) {
            for (let client in this._clients) {
                if (this._clients.hasOwnProperty(client)) {
                    try {
                        this._clients[client].send(data);
                    } catch(err) {
                        this.warn(RED._("websocket.errors.send-error")+" "+client+" "+err.toString())
                    }
                }
            }
        }
        else {
            try {
                this.server.send(data);
            } catch(err) {
                this.warn(RED._("websocket.errors.send-error")+" "+err.toString())
            }
        }
    }

    WebSocketListenerNode.prototype.reply = function(id,data) {
        var session = this._clients[id];
        if (session) {
            try {
                session.send(data);
            }
            catch(e) { // swallow any errors
            }
        }
    }

    function WebSocketInNode(n) {
        RED.nodes.createNode(this,n);
        this.server = (n.client)?n.client:n.server;
        var node = this;
		this.rxfilter = n.rxfilter;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (this.serverConfig) {
            this.serverConfig.registerInputNode(this);
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        } else {
            this.error(RED._("websocket.errors.missing-conf"));
        }
        this.on('close', function() {
            if (node.serverConfig) {
                node.serverConfig.removeInputNode(node);
            }
            node.status({});
        });
    }
    RED.nodes.registerType("Receive msg",WebSocketInNode);

    function WebSocketJSONOutNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;	
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
                }
                else {
                    payload = msg.payload;
                }
            }
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Send JSON",WebSocketJSONOutNode);

    function WebSocketMsgOutNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;	
			this.destination = parseInt(n.destination);
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
                }
                else {
                    payload = msg.payload;
                }
            }
			payload = ' {"AuthToken": "' + node.token + '", "Type": "chat",';
			payload += ' "TypeID": "590E4E6C-2C5D-47E8-8F38-311D5A299EE7",';				
			if(this.destination == 0)
			{
				payload += 	' "ConversationID": "' + node.receiver + '",';
			}
			else if(this.destination == 1)
			{
				payload += 	' "ReceiverID": "' + node.receiver + '",';
			}
			payload += ' "Body": "' + msg.payload + '" } '; 
			
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Send msg",WebSocketMsgOutNode);

    function WebSocketSelectNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;		
			this.choice1 = n.choice1;		
			this.choice2 = n.choice2;		
			this.choice3 = n.choice3;		
			this.choice4 = n.choice4;		
			this.choice5 = n.choice5;		
			this.choice6 = n.choice6;				
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
				}
                else {
                    payload = msg.payload;
                }
            }
			payload = ' {"AuthToken": "' + node.token + '",\
				"Type": "chat",\
				"TypeID": "4DB40F80-4C25-454B-BDB4-330A05285D71",';
			if(msg.payload.hasOwnProperty("Body")) 
			{
				payload += ' "Body": "' + msg.payload.Body + '",';
			}
			else
			{
				payload += ' "Body": "' + msg.payload + '",';
			}
							
			if(this.destination == 0)
			{
				payload += 	' "ConversationID": "' + node.receiver + '",';
			}
			else if(this.destination == 1)
			{
				payload += 	' "ReceiverID": "' + node.receiver + '",';
			}
			
			payload += 	' "Layout": "flexible", "Options": [';
			
			if(msg.payload.hasOwnProperty("Options")) 	
			{
				for(var i=0;i<msg.payload.Options.length;i++)
				{
					payload += '{"Text": "' + msg.payload.Options[i].Text + '", "Value": '+ msg.payload.Options[i].Value +'},';
				}
				payload = payload.slice(0, -1);//remove last comma
			}
			else
			{		
				if(node.choice1) payload += '{"Text": "' + node.choice1 + '", "Value": "1"},';
				if(node.choice2) payload += '{"Text": "' + node.choice2 + '", "Value": "2"},';
				if(node.choice3) payload += '{"Text": "' + node.choice3 + '", "Value": "3"},';
				if(node.choice4) payload += '{"Text": "' + node.choice4 + '", "Value": "4"},';
				if(node.choice5) payload += '{"Text": "' + node.choice5 + '", "Value": "5"},';
				if(node.choice6) payload += '{"Text": "' + node.choice6 + '", "Value": "6"},';
				payload = payload.slice(0, -1);//remove last comma
			}
			payload +=	'],	"Data": {}} '; 
			
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Select",WebSocketSelectNode);

    function WebSocketSendLocationNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;	
			this.latitude = n.latitude;		
			this.longitude = n.longitude;				
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
				}
                else {
                    payload = msg.payload;
                }
            }
			payload = '{"AuthToken": "' + node.token + '", "Type": "chat","TypeID": "4BDD5F50-DC68-11EA-9FCE-5302A705E738",';
			if(msg.payload.hasOwnProperty("Location")) 
			{
				payload += '"Location": {"latitude":'+ msg.payload.Location.latitude +',"longitude":' + msg.payload.Location.longitude +'},';
			payload += '"ConversationID": "' + node.receiver + '", "Body": "' + msg.payload.Body + '"}'; 
			}
			else
			{
				payload += '"Location": {"latitude":'+ node.latitude +',"longitude":' + node.longitude + '},';
			payload += '"ConversationID": "' + node.receiver + '", "Body": "' + msg.payload + '"}'; 
			}
			
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Send Location",WebSocketSendLocationNode);

    function WebSocketHTMLNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;					
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
				}
                else {
                    payload = msg.payload;
                }
            }
			payload = '{"AuthToken": "' + node.token + '", "Type": "chat","TypeID": "38199F47-504C-4C73-97E5-8076C8CFAA21",';
			if(this.destination == 0)
			{
				payload += 	' "ConversationID": "' + node.receiver + '",';
			}
			else if(this.destination == 1)
			{
				payload += 	' "ReceiverID": "' + node.receiver + '",';
			}
			payload += 	'"Body": "' + msg.payload.Body + '"}'; 
			
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Send HTML",WebSocketHTMLNode);

    function WebSocketDateNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;					
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
				}
                else {
                    payload = msg.payload;
                }
            }
			payload = '{"AuthToken": "' + node.token + '", "Type": "chat","TypeID": "242B5A3B-C1AF-4663-BD97-E296E3DB4D2F",';						
			if(this.destination == 0)
			{
				payload += 	' "ConversationID": "' + node.receiver + '",';
			}
			else if(this.destination == 1)
			{
				payload += 	' "ReceiverID": "' + node.receiver + '",';
			} 
			payload += 	'"Body": "' + msg.payload + '", "Data":{}}'; 
			
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Receive Date",WebSocketDateNode);

    function WebSocketTimeNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;					
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
				}
                else {
                    payload = msg.payload;
                }
            }
			payload = '{"AuthToken": "' + node.token + '", "Type": "chat","TypeID": "F489C072-2C8B-4BC6-AD75-946D3CA721B7",';
			if(this.destination == 0)
			{
				payload += 	' "ConversationID": "' + node.receiver + '",';
			}
			else if(this.destination == 1)
			{
				payload += 	' "ReceiverID": "' + node.receiver + '",';
			}
			payload += 	'"Body": "' + msg.payload + '", "Data":{}}'; 
			
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Receive Time",WebSocketTimeNode);

    function WebSocketRecLocationNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;					
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
				}
                else {
                    payload = msg.payload;
                }
            }
			
			payload = '{"AuthToken": "' + node.token + '", "Type": "chat","TypeID": "20A0CE4B-A236-4E96-9629-45A3AF5F62EA",';
			if(this.destination == 0)
			{
				payload += 	' "ConversationID": "' + node.receiver + '",';
			}
			else if(this.destination == 1)
			{
				payload += 	' "ReceiverID": "' + node.receiver + '",';
			}
			payload += '"Body": "' + msg.payload + '", "Data":{}}'; 
			
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Receive Location",WebSocketRecLocationNode);

    function WebSocketSendPhotoNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = (n.client)?n.client:n.server;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            return this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(event) {
                node.status({
                    fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count}),
                    event:"connect",
                    _session: {type:"websocket",id:event.id}
                });
            });
            this.serverConfig.on('erro', function(event) {
                node.status({
                    fill:"red",shape:"ring",text:"common.status.error",
                    event:"error",
                    _session: {type:"websocket",id:event.id}
                })
            });
            this.serverConfig.on('closed', function(event) {
                var status;
                if (event.count > 0) {
                    status = {fill:"green",shape:"dot",text:RED._("websocket.status.connected",{count:event.count})};
                } else {
                    status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
                }
                status.event = "disconnect";
                status._session = {type:"websocket",id:event.id}
                node.status(status);
            });
        }
        this.on("input", function(msg, nodeSend, nodeDone) {
            var payload;	
			this.token = n.token;
			this.destination = parseInt(n.destination);
			this.receiver = n.receiver;				
            if (this.serverConfig.wholemsg) {
                var sess;
                if (msg._session) { sess = JSON.stringify(msg._session); }
                delete msg._session;
                payload = JSON.stringify(msg);
                if (sess) { msg._session = JSON.parse(sess); }
            }
            else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
				}
                else {
                    payload = msg.payload;
                }
            }
			payload = ' {"AuthToken": "' + node.token + '",\
				"Type": "chat",\
				"TypeID": "969B986D-37C5-4E2E-BC59-944A3BC77CBC",';
			if(this.destination == 0)
			{
				payload += 	' "ConversationID": "' + node.receiver + '",';
			}
			else if(this.destination == 1)
			{
				payload += 	' "ReceiverID": "' + node.receiver + '",';
			}
			payload += 	' "Photos": [{"FileID": "1", "FileName": "v"}], \
			"Body": "' + msg.payload + '" }'; 
			
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id,payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error) {
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }
            nodeDone();
        });
        this.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Send Photo",WebSocketSendPhotoNode);
}