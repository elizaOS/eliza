# Sample: `multiparty_should_respond decision (ishiki-labs-multi-party-dialogue)`

- **source_dataset:** `ishiki-labs-multi-party-dialogue`
- **task_type:** `should_respond`
- **split:** `test`
- **license:** `apache-2.0`
- **agentId:** `d`
- **roomName:** `ed10562ffabadfdc1e3f4266`

> Same shouldRespond schema, but the agent label is one of A/B/C/D drawn from a multi-party dialogue corpus.

## currentMessage

```
role:    user
speaker: C
channel: public

content:
Okay and the twelve fifty twelve uh twelve
```

## memoryEntries (1 entries)

### entry[0]

```
role: user
speaker: C
channel: public

content:
Yeah .
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
name: D
reasoning: D spoke next in conversation (ground truth)
action: RESPOND
primaryContext: general
secondaryContexts: ""
evidenceTurnIds: ""
```