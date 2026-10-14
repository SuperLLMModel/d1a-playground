// The model server's OpenAI routes on a LAN port, so apps that used LM Studio's server (mem0, n8n, chat UIs) reach D1A at
// the address they already have (OPENAI_PORT=1234 in .demo/mini.env, d1a#274). Only chat, embeddings and the model list
// pass; everything else, the System One routes and /v1/feedback included, stays on the model server's 127.0.0.1 port.
// No key, like LM Studio's server. Streams (chat with "stream": true) pass through as they come.
//   node scripts/openai_port.mjs <listen host> <listen port> <model server URL, e.g. http://127.0.0.1:8009>
import http from "node:http";
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
      r.pipe(res);
    });
    up.on("error", () => (res.headersSent ? res.destroy() : error(res, 502, "the D1A model server is not answering")));
    res.on("close", () => up.destroy());   // the client left: stop reading a stream nobody will receive
    req.pipe(up);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host, port, upstream] = process.argv.slice(2);
  if (!host || !port || !upstream) { console.error("usage: node scripts/openai_port.mjs <host> <port> <model server URL>"); process.exit(2); }
  createProxy(upstream).listen(Number(port), host, () => console.log(`OpenAI routes on ${host}:${port} -> ${upstream}`));
}
