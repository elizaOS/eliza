# Real-model evidence — #10471 Recipe B (planner emits the enum natively, no English keywords needed)

Live model: `gpt-oss-120b` via https://api.cerebras.ai/v1 (OpenAI-compatible). temperature=0.
Each non-English case below contains ZERO English keywords, so the removed regexes
(`/\b(search|find)\b/`, `/\b(video|clip|film)\b/`) would have failed every one — yet the
planner routes them correctly via the structured enum.

## POST.action routing
```
EN  search my posts for vitalik      -> {"action":"search"}
JA  私の投稿を検索して                        -> {"action":"search"}
DE  zeig mir meinen feed             -> {"action":"read"}
FR  publie bonjour sur le feed       -> {"action":"send"}
KO  내 게시물 검색해줘                       -> {"action":"search"}
ZH  在我的动态里搜索                         -> {"action":"search"}
ES  busca en mis publicaciones       -> {"action":"search"}
```

## GENERATE_MEDIA.mediaType routing
```
JA  猫の動画を作って                           -> {"mediaType":"video"}
DE  mach ein Bild von einem Leuchtturm -> {"mediaType":"image"}
FR  génère une musique douce           -> {"mediaType":"audio"}
KO  고양이 비디오 만들어줘                       -> {"mediaType":"video"}
ZH  做一段音乐                              -> {"mediaType":"audio"}
```
