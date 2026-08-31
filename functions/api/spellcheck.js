// Cloudflare Pages Function: /api/spellcheck?text=...
// 브라우저에서 네이버 맞춤법 검사기를 직접 부르면 CORS로 막히므로,
// 이 서버리스 함수가 대신 호출해서 결과만 우리 프론트엔드로 넘겨준다.
// 네이버가 공식으로 제공하는 API가 아니라 비공개 내부 API를 우회 호출하는 것이라
// 언제든 깨질 수 있다 — 그래서 프론트엔드는 이게 실패하면 자체 규칙 기반 검사로 넘어간다.

const MAX_CHUNK = 480; // 네이버 맞춤법 검사기가 한 번에 처리 가능한 대략적인 길이
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function chunkText(text) {
  const paras = text.split('\n');
  const chunks = [];
  let current = '';
  const pushCurrent = () => { if (current) { chunks.push(current); current = ''; } };

  for (const para of paras) {
    let p = para;
    while (p.length > MAX_CHUNK) {
      // 문장 끝(마침표/느낌표/물음표+공백) 기준으로 최대한 자연스럽게 자른다
      let cut = p.lastIndexOf('. ', MAX_CHUNK);
      if (cut < MAX_CHUNK * 0.4) cut = MAX_CHUNK; // 적당한 지점을 못 찾으면 그냥 길이로 자름
      else cut += 1;
      if (current) pushCurrent();
      chunks.push(p.slice(0, cut));
      p = p.slice(cut);
    }
    if ((current + '\n' + p).length > MAX_CHUNK && current) pushCurrent();
    current = current ? current + '\n' + p : p;
  }
  pushCurrent();
  return chunks.length ? chunks : [''];
}

async function getPassportKey() {
  const res = await fetch('https://search.naver.com/search.naver?query=' + encodeURIComponent('네이버 맞춤법 검사기'), {
    headers: { 'User-Agent': UA },
  });
  const html = await res.text();
  const m = html.match(/passportKey=([^&"}]+)/);
  if (!m) throw new Error('passportKey를 찾지 못함');
  return m[1];
}

async function checkChunk(chunk, passportKey) {
  if (!chunk.trim()) return chunk;
  const apiUrl = `https://m.search.naver.com/p/csearch/ocontent/util/SpellerProxy?passportKey=${encodeURIComponent(passportKey)}&_callback=cb&q=${encodeURIComponent(chunk)}&where=nexearch&color_blindness=0`;
  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, 'Referer': 'https://search.naver.com/' },
  });
  const body = await res.text();
  const jsonMatch = body.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('응답 형식이 예상과 다름');
  const data = JSON.parse(jsonMatch[0]);
  const result = data && data.message && data.message.result;
  if (!result) throw new Error('결과 없음');
  let corrected = result.notag_html != null ? result.notag_html : String(result.html || '').replace(/<[^>]+>/g, '');
  corrected = corrected
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return corrected;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const text = url.searchParams.get('text') || '';
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

  if (!text.trim()) {
    return new Response(JSON.stringify({ error: 'empty' }), { status: 400, headers });
  }

  try {
    const passportKey = await getPassportKey();
    const chunks = chunkText(text);
    const correctedChunks = [];
    for (const chunk of chunks) {
      correctedChunks.push(await checkChunk(chunk, passportKey));
    }
    const correctedText = correctedChunks.join('\n');
    return new Response(JSON.stringify({ correctedText }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 502, headers });
  }
}
