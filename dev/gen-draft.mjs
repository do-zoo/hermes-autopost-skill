// usage: node gen-draft.mjs <file> <title> <id|en> [bad]
import { writeFileSync } from "node:fs";
const [file, title, lang, bad] = process.argv.slice(2);
const p = lang === "en"
  ? "This paragraph carries a practical explanation that is long enough to satisfy the word count for pipeline testing, covering steps, reasons and simple examples for readers."
  : "Paragraf ini berisi penjelasan praktis yang cukup panjang supaya jumlah kata terpenuhi untuk pengujian, mencakup langkah, alasan, dan contoh sederhana bagi pembaca.";
const sec = (n) => `## ${lang === "en" ? "Part" : "Bagian"} ${n}\n\n${p} ${p}\n\n${p}\n`;
let body = `Pembukaan.\n\n${sec(1)}\n${sec(2)}\n${sec(3)}\n`;
if (bad) body = `# Judul H1\n\n${body}\n| a | b |\n|---|---|\n\n<div>x</div>\n\n[link](http://x.y)\n`;
writeFileSync(file, `---\ntitle: ${title}\nexcerpt: Ringkasan singkat artikel tentang ${title} untuk pengujian.\nmeta_description: Panduan praktis mengenai ${title} yang disusun untuk pengujian toolbox autopost secara menyeluruh.\n---\n${body}`);
