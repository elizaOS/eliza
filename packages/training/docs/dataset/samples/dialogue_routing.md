# Sample: `dialogue_routing (synthesized)`

- **source_dataset:** `synth-dialogue-routing`
- **task_type:** `dialogue_routing`
- **split:** `train`
- **license:** `synthetic`
- **agentId:** `mira`
- **roomName:** `c0041d9f25d4cae1f25f7df2`

> Routing decision; same TOON shape as shouldRespond.

## currentMessage

```
role:    user
speaker: user
channel: discord-dialogues

content:
stop pinging Mira, leave them alone
```

## memoryEntries (1 entries)

### entry[0]

```
role: user
speaker: user
channel: discord-dialogues

content:
<|im_start|>assistant
jc hop on fn rq<|im_end|>
<|im_start|>user
Ya habibe 110GB update<|im_end|>
<|im_start|>assistant
no time like the present<|im_end|>
<|im_start|>user
No time like shushing<|im_end|>
<|im_start|>assistant
i shall not be silenced<|im_end|><|end_of_text|>
```

## availableActions

Type: List[str] (count=3)

```
[
  "RESPOND",
  "IGNORE",
  "STOP"
]
```

## expectedResponse (verbatim)

```
name: Mira
reasoning: the user is asking the agent to stop responding.
action: STOP
primaryContext: general
secondaryContexts: ""
evidenceTurnIds: ""
```