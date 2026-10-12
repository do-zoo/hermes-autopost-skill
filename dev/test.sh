#!/usr/bin/env bash
# Integration test: autopost.mjs + the REAL post-article.ts + mock API.
# usage: (cd adapter && npm install) && dev/test.sh      # or ADAPTER_DIR=/path/to/scripts/post-article dev/test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
AP="node $ROOT/skill/autopost-article/scripts/autopost.mjs"
: "${ADAPTER_DIR:=$ROOT/adapter}"  # default: bundled adapter (run npm install there first)
W="$(mktemp -d)"; trap 'kill $MOCK 2>/dev/null; rm -rf "$W"' EXIT
export AUTOPOST_HOME="$W/home" AUTOPOST_SITES="$W/sites.json" INGET_TEST_TOKEN=secret-test
mkdir -p "$AUTOPOST_HOME"
cat > "$AUTOPOST_SITES" <<JSON
[{"id":"t","apiUrl":"http://localhost:4010","apiKeyEnv":"INGET_TEST_TOKEN","adapterDir":"$ADAPTER_DIR",
  "adapterCommand":["./node_modules/.bin/tsx","post-article.ts"],"niche":"video","bilingual":true,
  "minWords":100,"coverImage":"optional","planBacklogTarget":6,"planRefillBelow":3,"cadenceHours":24}]
JSON
echo ok > "$W/mode"
node "$HERE/mock-api.mjs" "$W/posts.log" "$W/mode" > "$W/mock.out" 2>&1 & MOCK=$!
sleep 1
PASS=0; FAIL=0
chk() { # name, expected, actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected '$2', got '$3')"; fi
}
has() { if grep -q -- "$2" <<<"$3"; then PASS=$((PASS+1)); echo "  PASS $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (missing '$2' in: $(head -c 300 <<<"$3"))"; fi; }
j() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));const a=process.argv[1];console.log(eval(a[0]==='['?'o'+a:'o.'+a))" "$1"; }
makedue() { node -e "const f=process.argv[1];const p=JSON.parse(require('fs').readFileSync(f));p.items.filter(i=>i.status==='pending').forEach(i=>i.scheduledFor='2020-01-01T00:00:00.000Z');require('fs').writeFileSync(f,JSON.stringify(p))" "$AUTOPOST_HOME/plans/t.json"; }

echo "1) precheck on empty home"
o=$($AP precheck); has "wakes with needs_topics" "needs_topics=6" "$o"

echo "2) context"
o=$($AP context --site t); chk "2 categories" 2 "$(j 'categories.length' <<<"$o")"; chk "need" 6 "$(j 'need' <<<"$o")"

echo "3) plan-add (dup + bad category + 3 good + 1 over target)"
cat > "$W/plan.json" <<'JSON'
{"items":[
 {"topic":"Cara memilih mikrofon untuk streaming","category":"production-tips"},
 {"topic":"Topik kategori karangan model","category":"nope"},
 {"topic":"Menyetel gain staging untuk live streaming di Mac","category":"production-tips"},
 {"topic":"Kesalahan umum mixing vokal untuk pemula","category":"production-tips"},
 {"topic":"Memilih audio interface di bawah dua juta rupiah","category":"streaming-gear"},
 {"topic":"Optimasi bitrate OBS untuk koneksi terbatas","category":"streaming-gear"},
 {"topic":"Teknik pencahayaan tiga titik untuk studio kecil","category":"production-tips"},
 {"topic":"Mengatur noise gate agar suara tidak terpotong","category":"production-tips"}]}
JSON
o=$($AP plan-add --site t --file "$W/plan.json"); chk "added 6" 6 "$(j 'added' <<<"$o")"
has "dup rejected" "duplicate" "$o"; has "bad category rejected" "unknown category" "$o"
o=$($AP precheck); has "due=1" "due=1" "$o"

echo "4) next -> bad draft -> revise -> good draft -> publish"
o=$($AP next --site t); ID=$(j 'item.id' <<<"$o"); IDP=$(j 'item.drafts.id.path' <<<"$o"); ENP=$(j 'item.drafts.en.path' <<<"$o")
node "$HERE/gen-draft.mjs" "$IDP" "Panduan gain staging untuk streaming" id bad
node "$HERE/gen-draft.mjs" "$ENP" "Gain staging guide for streaming" en
o=$($AP submit --site t --item "$ID"); rc=$?; chk "exit 10" 10 $rc; has "H1 flagged" "H1" "$o"; has "table flagged" "table" "$o"
node "$HERE/gen-draft.mjs" "$IDP" "Panduan gain staging untuk streaming" id
o=$($AP submit --site t --item "$ID" --dry-run); chk "dry-run exit 0" 0 $?
o=$($AP submit --site t --item "$ID"); chk "publish exit 0" 0 $?; has "published" published "$o"
chk "mock got bilingual post" true "$(node -e "const l=require('fs').readFileSync('$W/posts.log','utf8').trim().split('\n');console.log(JSON.parse(l[l.length-1]).hasEn)")"
chk "posts created = 1" 1 "$(wc -l < "$W/posts.log" | tr -d ' ')"

echo "5) idle precheck"
o=$($AP precheck); has "no due (backlog 5/6 >= refill 3)" '"wakeAgent":false' "$o"

echo "6) mock 500 -> deferred, drafts kept, recover"
makedue; echo 500 > "$W/mode"
o=$($AP next --site t); ID=$(j 'item.id' <<<"$o"); IDP=$(j 'item.drafts.id.path' <<<"$o"); ENP=$(j 'item.drafts.en.path' <<<"$o")
node "$HERE/gen-draft.mjs" "$IDP" "Memilih audio interface murah" id; node "$HERE/gen-draft.mjs" "$ENP" "Choosing a cheap audio interface" en
o=$($AP submit --site t --item "$ID"); chk "exit 20" 20 $?; has deferred deferred "$o"
echo ok > "$W/mode"; makedue
o=$($AP next --site t); chk "same item reclaimed" "$ID" "$(j 'item.id' <<<"$o")"; chk "id draft exists" true "$(j 'item.drafts.id.exists' <<<"$o")"
chk "attempts unchanged" 0 "$(j 'item.attempts' <<<"$o")"
o=$($AP submit --site t --item "$ID"); chk "resend ok" 0 $?

echo "7) mock 'exists' -> failed (30)"
makedue; echo exists > "$W/mode"
o=$($AP next --site t); ID=$(j 'item.id' <<<"$o"); IDP=$(j 'item.drafts.id.path' <<<"$o"); ENP=$(j 'item.drafts.en.path' <<<"$o")
node "$HERE/gen-draft.mjs" "$IDP" "Kesalahan umum mixing vokal" id; node "$HERE/gen-draft.mjs" "$ENP" "Common vocal mixing mistakes" en
o=$($AP submit --site t --item "$ID"); chk "exit 30" 30 $?; has failed '"failed"' "$o"; echo ok > "$W/mode"

echo "8) bad token -> blocked, item back to pending, abortRun"
makedue
o=$(INGET_TEST_TOKEN=wrong $AP next --site t); ID=$(j 'item.id' <<<"$o"); IDP=$(j 'item.drafts.id.path' <<<"$o"); ENP=$(j 'item.drafts.en.path' <<<"$o")
node "$HERE/gen-draft.mjs" "$IDP" "Pencahayaan tiga titik studio kecil" id; node "$HERE/gen-draft.mjs" "$ENP" "Three point lighting small studio" en
o=$(INGET_TEST_TOKEN=wrong $AP submit --site t --item "$ID"); chk "exit 30" 30 $?; has abortRun abortRun "$o"
chk "item pending again" pending "$($AP status --site t | j '[0].problems.find(p=>p.id==="'$ID'")?.status')"
INGET_TEST_TOKEN=wrong $AP context --site t >/dev/null 2>&1; chk "context bad token exit 1" 1 $?

echo "9) parallel next -> distinct items"
makedue
( $AP next --site t > "$W/n1.json" & $AP next --site t > "$W/n2.json" & wait )
a=$(j 'item?.id' < "$W/n1.json"); b=$(j 'item?.id' < "$W/n2.json")
if [ "$a" != "$b" ]; then PASS=$((PASS+1)); echo "  PASS distinct ($a / $b)"; else FAIL=$((FAIL+1)); echo "  FAIL same item claimed twice: $a"; fi

addpending() { node -e "const f=process.argv[1];const n=+process.argv[2];const p=JSON.parse(require('fs').readFileSync(f));for(let i=0;i<n;i++)p.items.push({id:'x'+Date.now().toString(36)+i,topic:'Topik tambahan nomor '+i+' '+Math.random(),angle:'',keywords:[],category:'production-tips',status:'pending',attempts:0,lastError:'',remoteRef:'',scheduledFor:'2020-01-01T00:00:00.000Z'});require('fs').writeFileSync(f,JSON.stringify(p))" "$AUTOPOST_HOME/plans/t.json" "$1"; }
addpending 5
echo "11) cover image: optional, saved, validated, attached"
mkdir -p "$W/img"
node -e "require('fs').writeFileSync(process.argv[1],Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(200,1)]))" "$W/img/gen.png"
echo "secret=abc" > "$W/img/fake.png"
makedue; makedue
o=$($AP next --site t); ID=$(j 'item.id' <<<"$o"); IDP=$(j 'item.drafts.id.path' <<<"$o"); ENP=$(j 'item.drafts.en.path' <<<"$o")
chk "next advertises cover" optional "$(j 'item.cover.mode' <<<"$o")"
node "$HERE/gen-draft.mjs" "$IDP" "Panduan memilih pencahayaan" id; node "$HERE/gen-draft.mjs" "$ENP" "Lighting guide" en
$AP cover --site t --item "$ID" --file "$W/img/fake.png" >/dev/null 2>&1; chk "non-image rejected (magic bytes)" 1 $?
$AP cover --site t --item "$ID" --file /etc/passwd >/dev/null 2>&1; chk "/etc/passwd rejected" 1 $?
o=$($AP cover --site t --item "$ID" --file "$W/img/gen.png"); chk "cover saved" cover-saved "$(j 'result' <<<"$o")"
o=$($AP submit --site t --item "$ID" --dry-run); has "dry-run reports cover" "cover.png" "$o"
o=$($AP submit --site t --item "$ID"); chk "publish with cover exit 0" 0 $?; has "cover attached" '"cover": "attached"' "$o"
chk "mock got cover url" "https://cdn.test/media/cover-1.png" "$(node -e "const l=require('fs').readFileSync('$W/posts.log','utf8').trim().split('\n');console.log(JSON.parse(l[l.length-1]).cover)")"

echo "12) cover upload refused (no media scope) -> optional cover is skipped, article still posts"
makedue; echo nomedia > "$W/mode"
o=$($AP next --site t); ID=$(j 'item.id' <<<"$o"); IDP=$(j 'item.drafts.id.path' <<<"$o"); ENP=$(j 'item.drafts.en.path' <<<"$o")
node "$HERE/gen-draft.mjs" "$IDP" "Memilih lensa untuk video" id; node "$HERE/gen-draft.mjs" "$ENP" "Choosing lenses for video" en
$AP cover --site t --item "$ID" --file "$W/img/gen.png" >/dev/null
o=$($AP submit --site t --item "$ID"); chk "exit 0 despite refused cover" 0 $?; has "warning present" "WITHOUT cover" "$o"; has "cover none" '"cover": "none"' "$o"
echo ok > "$W/mode"

echo "13) required cover missing -> revise; then OK"
node -e "const f=process.argv[1];const a=JSON.parse(require('fs').readFileSync(f));a[0].coverImage='required';require('fs').writeFileSync(f,JSON.stringify(a))" "$AUTOPOST_SITES"
makedue
o=$($AP next --site t); ID=$(j 'item.id' <<<"$o"); IDP=$(j 'item.drafts.id.path' <<<"$o"); ENP=$(j 'item.drafts.en.path' <<<"$o")
node "$HERE/gen-draft.mjs" "$IDP" "Rekaman audio yang bersih di lokasi" id; node "$HERE/gen-draft.mjs" "$ENP" "Clean location audio" en
o=$($AP submit --site t --item "$ID"); chk "required cover missing -> exit 10" 10 $?; has "asks for cover" "cover image required" "$o"
$AP cover --site t --item "$ID" --file "$W/img/gen.png" >/dev/null
o=$($AP submit --site t --item "$ID"); chk "then publishes" 0 $?
node -e "const f=process.argv[1];const a=JSON.parse(require('fs').readFileSync(f));a[0].coverImage='off';require('fs').writeFileSync(f,JSON.stringify(a))" "$AUTOPOST_SITES"
$AP cover --site t --item x --file "$W/img/gen.png" >/dev/null 2>&1; chk "cover command refused when off" 1 $?

echo "14) body images still rejected"
makedue
o=$($AP next --site t); ID=$(j 'item.id' <<<"$o"); IDP=$(j 'item.drafts.id.path' <<<"$o"); ENP=$(j 'item.drafts.en.path' <<<"$o")
node "$HERE/gen-draft.mjs" "$IDP" "Topik gambar" id; node "$HERE/gen-draft.mjs" "$ENP" "Image topic" en
printf '\n![x](http://evil.test/a.png)\n' >> "$IDP"
o=$($AP submit --site t --item "$ID"); chk "body image -> exit 10" 10 $?; has "image flagged" "contains an image" "$o"

echo "10) status"
$AP status --site t | head -20
echo; echo "passed=$PASS failed=$FAIL"; [ "$FAIL" = 0 ]
