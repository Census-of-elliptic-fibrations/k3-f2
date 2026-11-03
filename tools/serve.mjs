// A small local web server with HTTP range requests, for trying the site on your own computer.
//     node tools/serve.mjs [port]
// Then open http://localhost:8080/ .  Stop it with Ctrl+C.  GitHub Pages does not use this file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const port = Number(process.argv[2]) || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain', '.woff2': 'font/woff2' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, url.endsWith('/') ? url + 'index.html' : url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Serving ${root} at http://localhost:${port}/`));
