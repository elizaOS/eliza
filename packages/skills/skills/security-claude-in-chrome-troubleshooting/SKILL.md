---
name: security-claude-in-chrome-troubleshooting
description: "Troubleshoot security issues with browser extensions and Chrome-based tools. Use when diagnosing browser extension security problems, Content Security Policy conflicts, cross-origin issues, extension permission problems, or browser automation security concerns."
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# Browser Extension Security Troubleshooting

## When to Use

- Diagnosing Content Security Policy (CSP) violations blocking extension functionality
- Troubleshooting cross-origin request failures in browser extensions
- Debugging extension permission issues
- Resolving conflicts between extensions and page security policies
- Investigating browser automation tool security warnings

## When NOT to Use

- General Chrome debugging without security context
- Server-side security issues
- Mobile app security testing

## Common Issues

### Content Security Policy Violations

```bash
# Check page CSP headers
curl -sI https://example.com | grep -i "content-security-policy"

# Common CSP directives that block extensions
# script-src: blocks injected scripts
# connect-src: blocks fetch/XHR to extension URLs
# frame-src: blocks iframes from extensions
```

**Fix approaches:**
1. Use `chrome.declarativeNetRequest` to modify CSP headers
2. Use `world: "MAIN"` for content scripts needing page context
3. Use message passing instead of direct DOM manipulation

### Cross-Origin Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| CORS error in extension | Missing host permission | Add origin to `host_permissions` in manifest |
| Blocked by CORB | Response MIME type mismatch | Use background script as proxy |
| `opaque` response | `no-cors` mode fetch | Use `cors` mode with proper headers |

### Extension Permission Problems

```json
// manifest.json - common permission issues
{
  "permissions": [
    "activeTab",      // Preferred over broad host access
    "scripting",      // Required for script injection
    "storage"         // For local extension data
  ],
  "host_permissions": [
    "https://specific-domain.com/*"  // Prefer specific over <all_urls>
  ]
}
```

### Debugging Steps

1. Open `chrome://extensions` and check for errors
2. Inspect extension background/service worker console
3. Check `chrome://net-internals/#events` for network issues
4. Review `chrome://policy` for enterprise-managed restrictions
5. Test in a clean profile to rule out extension conflicts

## Security Best Practices for Extensions

1. Request minimum required permissions
2. Use `activeTab` instead of broad host permissions where possible
3. Validate all messages received via `chrome.runtime.onMessage`
4. Sanitize any content injected into pages
5. Use Content Security Policy in extension pages
6. Avoid `eval()` and inline scripts in extension code
