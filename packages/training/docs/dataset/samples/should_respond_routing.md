# Sample: `should_respond decision (synthesized)`

- **source_dataset:** `synth-routing-v2`
- **task_type:** `should_respond_with_context`
- **split:** `train`
- **license:** `cc-by-sa-4.0`
- **agentId:** `juno`
- **roomName:** `529d337fa6e967a338d2c03c`

> shouldRespond decision: `expectedResponse` is TOON with `name + reasoning + action + primaryContext + secondaryContexts + evidenceTurnIds`. The `action` is one of `RESPOND | IGNORE | STOP`.

## currentMessage

```
role:    user
speaker: asst_7558
channel: public

content:
yo juno: No im scared
```

## memoryEntries (5 entries)

### entry[0]

```
role: user
speaker: tg_9425
channel: discord-dlg-3560

content:
The OSHA Act does not authorize such expansive powers, the highest court of the United States said.
```

### entry[1]

```
role: user
speaker: tg_2479
channel: discord-dlg-3560

content:
Our top stories this morning BonginoReport.com pic.twitter.com/nZPt9S5MiT
```

### entry[2]

```
role: user
speaker: asst_2490
channel: discord-dlg-3560

content:
more incidents incoming in todays q for you btw
```

### entry[3]

```
role: user
speaker: StellaAthena#3530
channel: discord-dlg-3560

content:
> Once training is finished, you can run the same command with the --predict flag to sample from your model.
```

### entry[4]

```
role: user
speaker: chilli#5665
channel: discord-dlg-3560

content:
This is actually kind of a neat way of measuring how many ops a primitive is worth
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
name: juno
reasoning: direct mention of juno in the latest message — addressed to the agent.
action: RESPOND
primaryContext: general
secondaryContexts: ""
evidenceTurnIds: ""
```