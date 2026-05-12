# 🤖 AI News Daily — {{date}}

Good morning! Here's what's happening in AI today:

{{#each stories}}
## {{this.rank}}. {{this.title}}
**Source:** {{this.source}} | {{this.time_ago}}

{{this.summary}}

[Read more]({{this.url}})

{{/each}}

---

## 📊 Quick Stats
- Stories scanned: {{total_scanned}}
- Top stories selected: {{total_selected}}
- Key themes: {{themes}}

---
_Curated by Jarvis at {{generated_at}}_
