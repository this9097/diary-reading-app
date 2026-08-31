// Cloudflare Pages Function: /api/ai-spellcheck?text=...
// Claude API를 이용해 문맥을 이해하는 수준의 맞춤법/오탈자 교정을 한다.
// (예: "않아"→"앉아", "아나의"→"아내의" 같은, 문법 규칙만으로는 못 잡는 오탈자)
// CLAUDE_API_KEY 환경변수가 Cloudflare Pages 프로젝트에 설정돼 있어야 동작한다.
// 설정 안 돼 있으면 501을 돌려주고, 프론트엔드는 자동으로 네이버 맞춤법 검사로 넘어간다.

const SYSTEM_PROMPT =
  '너는 한국어 교정 도우미다. 사용자가 준 글의 맞춤법, 띄어쓰기, 오탈자, 문장부호만 자연스럽게 고쳐라. ' +
  '문체, 어투, 의미, 문단 구성은 절대 바꾸지 마라. 새로운 내용을 추가하거나 빼지 마라. ' +
  '설명이나 인사말, 부가 텍스트 없이 교정된 전체 글만 그대로 출력해라.';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const text = url.searchParams.get('text') || '';
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

  if (!text.trim()) {
    return new Response(JSON.stringify({ error: 'empty' }), { status: 400, headers });
  }

  const apiKey = context.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'CLAUDE_API_KEY가 설정되지 않았습니다' }), { status: 501, headers });
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`API 오류 ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const corrected = (data.content || []).map((b) => b.text || '').join('').trim();
    if (!corrected) throw new Error('빈 응답');
    return new Response(JSON.stringify({ correctedText: corrected }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 502, headers });
  }
}
