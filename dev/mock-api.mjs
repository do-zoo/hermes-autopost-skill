// Minimal mock of the Inget Gue API (categories, posts list, create). Token: secret-test
// usage: node mock-api.mjs <postlog> <modefile>   (modefile content: ok | 500 | exists)
import http from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [POSTLOG, MODEFILE] = process.argv.slice(2);
const TOKEN = "secret-test";
const mode = () => (existsSync(MODEFILE) ? readFileSync(MODEFILE, "utf8").trim() : "ok");

const categories = [
  { id: "c1", nameId: "Tips Produksi", nameEn: "Production Tips", slugId: "tips-produksi", slugEn: "production-tips" },
  { id: "c2", nameId: "Perlengkapan Streaming", nameEn: "Streaming Gear", slugId: "perlengkapan-streaming", slugEn: "streaming-gear" },
];
const posts = [
  { id: "p0", titleId: "Cara memilih mikrofon untuk streaming", slugId: "cara-memilih-mikrofon-untuk-streaming", status: "ACTIVE" },
];

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      // ---- Inget Gue API ----
      if (url.pathname.startsWith("/api/")) {
        if (req.headers["authorization"] !== `Bearer ${TOKEN}`) {
          return send(401, { success: false, error: { message: "invalid token" } });
        }
        if (req.method === "GET" && url.pathname === "/api/posts/categories") {
          return send(200, { success: true, data: categories });
        }
        if (req.method === "GET" && url.pathname === "/api/posts") {
          return send(200, { success: true, data: { data: posts, meta: { totalPages: 1 } } });
        }
        if (req.method === "POST" && url.pathname === "/api/posts") {
          const body = JSON.parse(raw);
          const m = mode();
          if (m === "500") return send(500, { success: false, error: { message: "boom" } });
          if (m === "exists") {
            posts.push({ id: "p-existing", titleId: body.titleId, slugId: body.slugId, status: "ACTIVE" });
            return send(409, { success: false, error: { message: "slug already used" } });
          }
          if (!categories.some((c) => c.id === body.categoryId)) {
            return send(400, { success: false, error: { message: "unknown categoryId" } });
          }
          for (const k of ["titleId", "excerptId", "contentId"]) {
            if (!body[k]) return send(400, { success: false, error: { message: `${k} required` } });
          }
          const en = ["titleEn", "excerptEn", "contentEn"].filter((k) => body[k]).length;
          if (en !== 0 && en !== 3) {
            return send(400, { success: false, error: { message: "English version must be complete" } });
          }
          if (posts.some((p) => p.slugId === body.slugId)) {
            return send(409, { success: false, error: { message: "slug already used" } });
          }
          const id = `p${posts.length}`;
          posts.push({ id, titleId: body.titleId, slugId: body.slugId, status: "INACTIVE" });
          appendFileSync(
            POSTLOG,
            JSON.stringify({
              id,
              titleId: body.titleId,
              slugId: body.slugId,
              slugEn: body.slugEn ?? null,
              hasEn: en === 3,
              contentIdStart: body.contentId.slice(0, 30),
              categoryId: body.categoryId,
              status: body.status ?? "(unset)",
            }) + "\n",
          );
          return send(201, {
            success: true,
            data: { id, status: "INACTIVE", slugId: body.slugId, slugEn: body.slugEn ?? null, coverImageUrl: null },
          });
        }
        return send(404, { success: false, error: { message: "not found" } });
      }
      send(404, { error: "nf" });
    });
  })
  .listen(4010, () => console.log("mock up"));
