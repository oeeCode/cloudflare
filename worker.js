// src/worker.ts
import { connect } from "cloudflare:sockets";
var userID = "0ff9bd31-5f09-415d-b191-a9810a553327";
var proxyIPs = ['104.26.0.0', '172.67.64.0', '104.16.192.0'];
var proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];
var dohURL = "https://cloudflare-dns.com/dns-query";
var nodeId = "";
var apiToken = "";
var apiHost = "";
if (!isValidUUID(userID)) {
  throw new Error("uuid is not valid");
}
var worker_default = {
  /**
   * @param {import("@cloudflare/workers-types").Request} request
   * @param {{UUID: string, PROXYIP: string, DNS_RESOLVER_URL: string, NODE_ID: int, API_HOST: string, API_TOKEN: string}} env
   * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    try {
      userID = env.UUID || userID;
      proxyIP = env.PROXYIP || proxyIP;
      dohURL = env.DNS_RESOLVER_URL || dohURL;
      nodeId = env.NODE_ID || nodeId;
      apiToken = env.API_TOKEN || apiToken;
      apiHost = env.API_HOST || apiHost;
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        const url = new URL(request.url);
        switch (url.pathname) {
          case "/cf":
            return new Response(JSON.stringify(request.cf, null, 4), {
              status: 200,
              headers: {
                "Content-Type": "application/json;charset=utf-8"
              }
            });
          case "/connect":
            const [hostname, port] = ["cloudflare.com", "80"];
            console.log(`Connecting to ${hostname}:${port}...`);
            try {
              const socket = await connect({
                hostname,
                port: parseInt(port, 10)
              });
              const writer = socket.writable.getWriter();
              try {
                await writer.write(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: " + hostname + "\r\n\r\n"));
              } catch (writeError) {
                writer.releaseLock();
                await socket.close();
                return new Response(writeError.message, { status: 500 });
              }
              writer.releaseLock();
              const reader = socket.readable.getReader();
              let value;
              try {
                const result = await reader.read();
                value = result.value;
              } catch (readError) {
                await reader.releaseLock();
                await socket.close();
                return new Response(readError.message, { status: 500 });
              }
              await reader.releaseLock();
              await socket.close();
              return new Response(new TextDecoder().decode(value), { status: 200 });
            } catch (connectError) {
              return new Response(connectError.message, { status: 500 });
            }
          case `/${userID}`: {
            const vlessConfig = getVLESSConfig(userID, request.headers.get("Host"));
            return new Response(`${vlessConfig}`, {
              status: 200,
              headers: {
                "Content-Type": "text/plain;charset=utf-8"
              }
            });
          }
          default:
            url.hostname = "global.cctv.com";
            url.protocol = "https:";
            request = new Request(url, request);
            return await fetch(request);
        }
      } else {
        return await vlessOverWSHandler(request);
      }
    } catch (err) {
      let e = err;
      return new Response(e.toString());
    }
  }
};
async function vlessOverWSHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let address = "";
  let portWithRandomLog = "";
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || "");
  };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = {
    value: null
  };
  let udpStreamWrite = null;
  let isDns = false;
  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      if (remoteSocketWapper.value) {
        const writer = remoteSocketWapper.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      const {
        hasError,
        message,
        portRemote = [443, 8443, 2053, 2083, 2087, 2096, 80, 8080, 8880, 2052, 2082, 2086, 2095],
        addressRemote = "",
        rawDataIndex,
        vlessVersion = new Uint8Array([0, 0]),
        isUDP
      } = await processVlessHeader(chunk, userID);
      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? "udp " : "tcp "} `;
      if (hasError) {
        throw new Error(message);
        return;
      }
      if (isUDP) {
        if (portRemote === 53) {
          isDns = true;
        } else {
          throw new Error("UDP proxy only enable for DNS which is port 53");
          return;
        }
      }
      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isDns) {
        const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
    },
    close() {
      log(`readableWebSocketStream is close`);
    },
    abort(reason) {
      log(`readableWebSocketStream is abort`, JSON.stringify(reason));
    }
  })).catch((err) => {
    log("readableWebSocketStream pipeTo error", err);
  });
  return new Response(null, {
    status: 101,
    // @ts-ignore
    webSocket: client
  });
}
var apiResponseCache = null;
var cacheTimeout = null;
async function fetchApiResponse() {
  const requestOptions = {
    method: "GET",
    redirect: "follow"
  };
  try {
    const response = await fetch(`https://${apiHost}/api/v1/server/UniProxy/user?node_id=${nodeId}&node_type=v2ray&token=${apiToken}`, requestOptions);
    if (!response.ok) {
      console.error("Error: Network response was not ok");
      return null;
    }
    const apiResponse = await response.json();
    apiResponseCache = apiResponse;
    if (cacheTimeout) {
      clearTimeout(cacheTimeout);
    }
    cacheTimeout = setTimeout(() => fetchApiResponse(), 3e5);
    return apiResponse;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}
async function getApiResponse() {
  if (!apiResponseCache) {
    return await fetchApiResponse();
  }
  return apiResponseCache;
}
async function checkUuidInApiResponse(targetUuid) {
  if (!nodeId || !apiToken || !apiHost) {
    return false;
  }
  try {
    const apiResponse = await getApiResponse();
    if (!apiResponse) {
      return false;
    }
    const isUuidInResponse = apiResponse.users.some((user) => user.uuid === targetUuid);
    return isUuidInResponse;
  } catch (error) {
    console.error("Error:", error);
    return false;
  }
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
  async function connectAndWrite(address, port) {
    const tcpSocket2 = connect({
      hostname: address,
      port
    });
    remoteSocket.value = tcpSocket2;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket2.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket2;
  }
  async function retry() {
    const tcpSocket2 = await connectAndWrite(proxyIP || addressRemote, portRemote);
    tcpSocket2.closed.catch((error) => {
      console.log("retry tcpSocket closed error", error);
    }).finally(() => {
      safeCloseWebSocket(webSocket);
    });
    remoteSocketToWS(tcpSocket2, webSocket, vlessResponseHeader, null, log);
  }
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener("message", (event) => {
        if (readableStreamCancel) {
          return;
        }
        const message = event.data;
        controller.enqueue(message);
      });
      webSocketServer.addEventListener(
        "close",
        () => {
          safeCloseWebSocket(webSocketServer);
          if (readableStreamCancel) {
            return;
          }
          controller.close();
        }
      );
      webSocketServer.addEventListener(
        "error",
        (err) => {
          log("webSocketServer has error");
          controller.error(err);
        }
      );
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    pull(controller) {
    },
    cancel(reason) {
      if (readableStreamCancel) {
        return;
      }
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    }
  });
  return stream;
}
async function processVlessHeader(vlessBuffer, userID2) {
  if (vlessBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: "invalid data"
    };
  }
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;
  const slicedBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
  const slicedBufferString = stringify(slicedBuffer);
  const uuids = userID2.includes(",") ? userID2.split(",") : [userID2];
  const checkUuidInApi = await checkUuidInApiResponse(slicedBufferString);
  isValidUser = uuids.some((userUuid) => checkUuidInApi || slicedBufferString === userUuid.trim());
  console.log(`checkUuidInApi: ${await checkUuidInApiResponse(slicedBufferString)}, userID: ${slicedBufferString}`);
  if (!isValidUser) {
    return {
      hasError: true,
      message: "invalid user"
    };
  }
  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(
    vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
  )[0];
  if (command === 1) {
  } else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`
    };
  }
  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(
    vlessBuffer.slice(addressIndex, addressIndex + 1)
  );
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = "";
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join(".");
      break;
    case 2:
      addressLength = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(":");
      break;
    default:
      return {
        hasError: true,
        message: `invild  addressType is ${addressType}`
      };
  }
  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`
    };
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP
  };
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
  let remoteChunkCount = 0;
  let chunks = [];
  let vlessHeader = vlessResponseHeader;
  let hasIncomingData = false;
  await remoteSocket.readable.pipeTo(
    new WritableStream({
      start() {
      },
      /**
       *
       * @param {Uint8Array} chunk
       * @param {*} controller
       */
      async write(chunk, controller) {
        hasIncomingData = true;
        if (webSocket.readyState !== WS_READY_STATE_OPEN) {
          controller.error(
            "webSocket.readyState is not open, maybe close"
          );
        }
        if (vlessHeader) {
          webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
          vlessHeader = null;
        } else {
          webSocket.send(chunk);
        }
      },
      close() {
        log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
      },
      abort(reason) {
        console.error(`remoteConnection!.readable abort`, reason);
      }
    })
  ).catch((error) => {
    console.error(
      `remoteSocketToWS has exception `,
      error.stack || error
    );
    safeCloseWebSocket(webSocket);
  });
  if (hasIncomingData === false && retry) {
    log(`retry`);
    retry();
  }
}
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { error: null };
  }
  try {
    base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
var WS_READY_STATE_OPEN = 1;
var WS_READY_STATE_CLOSING = 2;
function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error("safeCloseWebSocket error", error);
  }
}
var byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    start(controller) {
    },
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPakcetLength)
        );
        index = index + 2 + udpPakcetLength;
        controller.enqueue(udpData);
      }
    },
    flush(controller) {
    }
  });
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const resp = await fetch(
        dohURL,
        // dns server url
        {
          method: "POST",
          headers: {
            "content-type": "application/dns-message"
          },
          body: chunk
        }
      );
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSize = dnsQueryResult.byteLength;
      const udpSizeBuffer = new Uint8Array([udpSize >> 8 & 255, udpSize & 255]);
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        log(`doh success and dns message length is ${udpSize}`);
        if (isVlessHeaderSent) {
          webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
        } else {
          webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
          isVlessHeaderSent = true;
        }
      }
    }
  })).catch((error) => {
    log("dns udp has error" + error);
  });
  const writer = transformStream.writable.getWriter();
  return {
    /**
     *
     * @param {Uint8Array} chunk
     */
    write(chunk) {
      writer.write(chunk);
    }
  };
}
function getVLESSConfig(userID2, hostName) {
  const wvlessws = `vless://${userID2}@skk.moe:8880?encryption=none&security=none&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
  const pvlesswstls = `vless://${userID2}@skk.moe:8443?encryption=none&security=tls&type=ws&host=${hostName}&sni=${hostName}&fp=random&path=%2F%3Fed%3D2048#${hostName}`;
  if (hostName.includes("pages.dev")) {
    return `
  ==========================\u914D\u7F6E\u8BE6\u89E3==============================

  ################################################################
  CF-pages-vless+ws+tls\u8282\u70B9\uFF0C\u5206\u4EAB\u94FE\u63A5\u5982\u4E0B\uFF1A

  ${pvlesswstls}

  ---------------------------------------------------------------
  \u6CE8\u610F\uFF1A\u5982\u679C ${hostName} \u5728\u672C\u5730\u7F51\u7EDC\u6253\u4E0D\u5F00\uFF08\u4E2D\u56FD\u79FB\u52A8\u7528\u6237\u6CE8\u610F\uFF09
         \u5BA2\u6237\u7AEF\u9009\u9879\u7684\u4F2A\u88C5\u57DF\u540D(host)\u5FC5\u987B\u6539\u4E3A\u4F60\u5728CF\u89E3\u6790\u5B8C\u6210\u7684\u81EA\u5B9A\u4E49\u57DF\u540D
  ---------------------------------------------------------------
  \u5BA2\u6237\u7AEF\u5FC5\u8981\u6587\u660E\u53C2\u6570\u5982\u4E0B\uFF1A
  \u5BA2\u6237\u7AEF\u5730\u5740(address)\uFF1A\u81EA\u5B9A\u4E49\u7684\u57DF\u540D \u6216\u8005 \u4F18\u9009\u57DF\u540D \u6216\u8005 \u4F18\u9009IP\uFF08\u53CD\u4EE3IP\u5FC5\u987B\u4E0E\u53CD\u4EE3\u7AEF\u53E3\u5BF9\u5E94\uFF09
  \u7AEF\u53E3(port)\uFF1A6\u4E2Ahttps\u7AEF\u53E3\u53EF\u4EFB\u610F\u9009\u62E9(443\u30018443\u30012053\u30012083\u30012087\u30012096)
  \u7528\u6237ID(uuid)\uFF1A${userID2}
  \u4F20\u8F93\u534F\u8BAE(network)\uFF1Aws \u6216\u8005 websocket
  \u4F2A\u88C5\u57DF\u540D(host)\uFF1A${hostName}
  \u8DEF\u5F84(path)\uFF1A/?ed=2048
  \u4F20\u8F93\u5B89\u5168(TLS)\uFF1A\u5F00\u542F
  \u8DF3\u8FC7\u8BC1\u4E66\u9A8C\u8BC1(allowlnsecure)\uFF1Afalse
  ################################################################
  `;
  } else if (hostName.includes("workers.dev")) {
    return `
  ==========================\u914D\u7F6E\u8BE6\u89E3==============================

  ################################################################
  \u4E00\u3001CF-workers-vless+ws\u8282\u70B9\uFF0C\u5206\u4EAB\u94FE\u63A5\u5982\u4E0B\uFF1A

  ${wvlessws}

  ---------------------------------------------------------------
  \u6CE8\u610F\uFF1A\u5F53\u524D\u8282\u70B9\u65E0\u9700\u4F7F\u7528CF\u89E3\u6790\u5B8C\u6210\u7684\u57DF\u540D\uFF0C\u5BA2\u6237\u7AEF\u9009\u9879\u7684TLS\u9009\u9879\u5FC5\u987B\u5173\u95ED
  ---------------------------------------------------------------
  \u5BA2\u6237\u7AEF\u5FC5\u8981\u6587\u660E\u53C2\u6570\u5982\u4E0B\uFF1A
  \u5BA2\u6237\u7AEF\u5730\u5740(address)\uFF1A\u81EA\u5B9A\u4E49\u7684\u57DF\u540D \u6216\u8005 \u4F18\u9009\u57DF\u540D \u6216\u8005 \u4F18\u9009IP\uFF08\u53CD\u4EE3IP\u5FC5\u987B\u4E0E\u53CD\u4EE3\u7AEF\u53E3\u5BF9\u5E94\uFF09
  \u7AEF\u53E3(port)\uFF1A7\u4E2Ahttp\u7AEF\u53E3\u53EF\u4EFB\u610F\u9009\u62E9(80\u30018080\u30018880\u30012052\u30012082\u30012086\u30012095)
  \u7528\u6237ID(uuid)\uFF1A${userID2}
  \u4F20\u8F93\u534F\u8BAE(network)\uFF1Aws \u6216\u8005 websocket
  \u4F2A\u88C5\u57DF\u540D(host)\uFF1A${hostName}
  \u8DEF\u5F84(path)\uFF1A/?ed=2048
  ################################################################


  ################################################################

  \u67E5\u770BCF-workers-vless+ws+tls\u8282\u70B9\u914D\u7F6E\u4FE1\u606F\uFF0C\u8BF7\u5728\u6D4F\u89C8\u5668\u5730\u5740\u680F\u8F93\u5165\uFF1A\u4F60\u8BBE\u7F6E\u7684\u81EA\u5B9A\u4E49\u57DF\u540D/\u4F60\u8BBE\u7F6E\u7684UUID
  \u9632\u6B62\u5C0F\u767D\u8FC7\u591A\u7684\u64CD\u4F5C\u5931\u8BEF\uFF0C\u5FC5\u987B\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u57DF\u540D\u540E\u624D\u80FD\u4F7F\u7528Workers\u65B9\u5F0F\u7684TLS\u6A21\u5F0F\uFF0C\u5426\u5219\uFF0C\u5EFA\u8BAE\u53EA\u4F7F\u7528vless+ws\u8282\u70B9\u5373\u53EF
  \u63D0\u793A\uFF1A\u4F7F\u7528pages\u65B9\u5F0F\u90E8\u7F72\uFF0C\u8054\u901A\u3001\u7535\u4FE1\u7528\u6237\u5927\u6982\u7387\u53EF\u4EE5\u76F4\u63A5\u4F7F\u7528TLS\u6A21\u5F0F\uFF0C\u65E0\u9700\u8BBE\u7F6E\u81EA\u5B9A\u4E49\u57DF\u540D
  pages\u65B9\u5F0F\u90E8\u7F72\u53EF\u53C2\u8003\u6B64\u89C6\u9891\u6559\u7A0B\uFF1Ahttps://youtu.be/McdRoLZeTqg

  ################################################################
  `;
  } else {
    return `
  ==========================\u914D\u7F6E\u8BE6\u89E3==============================

  =====\u4F7F\u7528\u81EA\u5B9A\u4E49\u57DF\u540D\u67E5\u770B\u914D\u7F6E\uFF0C\u8BF7\u786E\u8BA4\u4F7F\u7528\u7684\u662Fworkers\u8FD8\u662Fpages=====

  ################################################################
  \u4E00\u3001CF-workers-vless+ws\u8282\u70B9\uFF0C\u5206\u4EAB\u94FE\u63A5\u5982\u4E0B\uFF1A

  ${wvlessws}

  ---------------------------------------------------------------
  \u6CE8\u610F\uFF1A\u5F53\u524D\u8282\u70B9\u65E0\u9700\u4F7F\u7528CF\u89E3\u6790\u5B8C\u6210\u7684\u57DF\u540D\uFF0C\u5BA2\u6237\u7AEF\u9009\u9879\u7684TLS\u9009\u9879\u5FC5\u987B\u5173\u95ED
  ---------------------------------------------------------------
  \u5BA2\u6237\u7AEF\u5FC5\u8981\u6587\u660E\u53C2\u6570\u5982\u4E0B\uFF1A
  \u5BA2\u6237\u7AEF\u5730\u5740(address)\uFF1A\u81EA\u5B9A\u4E49\u7684\u57DF\u540D \u6216\u8005 \u4F18\u9009\u57DF\u540D \u6216\u8005 \u4F18\u9009IP\uFF08\u53CD\u4EE3IP\u5FC5\u987B\u4E0E\u53CD\u4EE3\u7AEF\u53E3\u5BF9\u5E94\uFF09
  \u7AEF\u53E3(port)\uFF1A7\u4E2Ahttp\u7AEF\u53E3\u53EF\u4EFB\u610F\u9009\u62E9(80\u30018080\u30018880\u30012052\u30012082\u30012086\u30012095)
  \u7528\u6237ID(uuid)\uFF1A${userID2}
  \u4F20\u8F93\u534F\u8BAE(network)\uFF1Aws \u6216\u8005 websocket
  \u4F2A\u88C5\u57DF\u540D(host)\uFF1A${hostName}
  \u8DEF\u5F84(path)\uFF1A/?ed=2048
  ################################################################

  ################################################################
  \u4E8C\u3001CF-workers-vless+ws+tls \u6216\u8005 CF-pages-vless+ws+tls\u8282\u70B9\uFF0C\u5206\u4EAB\u94FE\u63A5\u5982\u4E0B\uFF1A

  ${pvlesswstls}

  ---------------------------------------------------------------
  \u6CE8\u610F\uFF1A\u5BA2\u6237\u7AEF\u9009\u9879\u7684\u4F2A\u88C5\u57DF\u540D(host)\u5FC5\u987B\u6539\u4E3A\u4F60\u5728CF\u89E3\u6790\u5B8C\u6210\u7684\u81EA\u5B9A\u4E49\u57DF\u540D
  ---------------------------------------------------------------
  \u5BA2\u6237\u7AEF\u5FC5\u8981\u6587\u660E\u53C2\u6570\u5982\u4E0B\uFF1A
  \u5BA2\u6237\u7AEF\u5730\u5740(address)\uFF1A\u81EA\u5B9A\u4E49\u7684\u57DF\u540D \u6216\u8005 \u4F18\u9009\u57DF\u540D \u6216\u8005 \u4F18\u9009IP\uFF08\u53CD\u4EE3IP\u5FC5\u987B\u4E0E\u53CD\u4EE3\u7AEF\u53E3\u5BF9\u5E94\uFF09
  \u7AEF\u53E3(port)\uFF1A6\u4E2Ahttps\u7AEF\u53E3\u53EF\u4EFB\u610F\u9009\u62E9(443\u30018443\u30012053\u30012083\u30012087\u30012096)
  \u7528\u6237ID(uuid)\uFF1A${userID2}
  \u4F20\u8F93\u534F\u8BAE(network)\uFF1Aws \u6216\u8005 websocket
  \u4F2A\u88C5\u57DF\u540D(host)\uFF1A${hostName}
  \u8DEF\u5F84(path)\uFF1A/?ed=2048
  \u4F20\u8F93\u5B89\u5168(TLS)\uFF1A\u5F00\u542F
  \u8DF3\u8FC7\u8BC1\u4E66\u9A8C\u8BC1(allowlnsecure)\uFF1Afalse
  ################################################################
  `;
  }
}
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
