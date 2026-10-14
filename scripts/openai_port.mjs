// The model server's OpenAI routes on a LAN port, so apps that used LM Studio's server (mem0, n8n, chat UIs) reach D1A at
// the address they already have (OPENAI_PORT=1234 in .demo/mini.env, d1a#274). Only chat, embeddings and the model list
// pass; everything else, the System One routes and /v1/feedback included, stays on the model server's 127.0.0.1 port.
// No key, like LM Studio's server. Streams (chat with "stream": true) pass through as they come.
//   node scripts/openai_port.mjs <listen host> <listen port> <model server URL, e.g. http://127.0.0.1:8009>
import { realpathSync } from "node:fs";
import http from "node:http";
import { pipeline } from "node:stream";
import { pathToFileURL } from "node:url";

const ROUTES = new Set(["POST /v1/chat/completions", "POST /v1/embeddings", "GET /v1/models"]);

export function allowed(method, url) {
  const path = new URL(url, "http://x").pathname;
  return ROUTES.has(`${method} ${path}`) && url.split("?")[0] === path;   // the exact path: no "..", "//" or %-escapes reach the server
}

function error(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}

export function createProxy(upstream) {
  const target = new URL(upstream);
  const server = http.createServer((req, res) => {
    if (!allowed(req.method, req.url)) return error(res, 404, `${req.method} ${req.url.split("?")[0]} is not served on this port`);
    const headers = { ...req.headers, host: target.host };
    delete headers.connection;
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      res.flushHeaders();
      pipeline(r, res, (err) => err && res.destroy());   // a model server that dies mid-stream ends the client's response too
    });
    up.on("error", () => (res.headersSent ? res.destroy() : error(res, 502, "the D1A model server is not answering")));
    res.on("close", () => up.destroy());   // the client left: stop reading a stream nobody will receive
    req.pipe(up);
  });
  server.keepAliveTimeout = 75_000;   // as the model server's (d1a#42): pooled clients (n8n, httpx) reuse an idle socket that
  server.headersTimeout = 80_000;     // Node's 5 s default would close under them; headersTimeout must exceed it
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {   // realpath: run through a symlink (macOS /tmp) it is still the main module
  const [host, port, upstream] = process.argv.slice(2);
  if (!host || !port || !upstream) { console.error("usage: node scripts/openai_port.mjs <host> <port> <model server URL>"); process.exit(2); }
  const server = createProxy(upstream);
  server.on("error", (e) => { console.error(`cannot listen on ${host}:${port}: ${e.message}`); process.exit(1); });   // launchd retries in 10 s
  server.listen(Number(port), host, () => console.log(`OpenAI routes on ${host}:${port} -> ${upstream}`));
}
