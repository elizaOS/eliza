# app-auth-authorize

- **route:** `app-auth/authorize`
- **path:** `/app-auth/authorize?app_id=app-smoke-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcb`

## desktop

- **verdict:** needs-eyeball
- **console errors:** Error: useAuth must be used within a <StewardProvider> with an `auth` prop.
    at useAuth (http://127.0.0.1:59796/assets/vendor-crypto-C3acyo1E.js:53131:11)
    at AuthorizeAuthenticatedContent (http://127.0.0.1:59796/assets/vendor-crypto-C3acyo1E.js:108915:7)
    at renderWithHooks (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:4142:23)
    at updateFunctionComponent (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:5771:17)
    at beginWork (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:6382:16)
    at performUnitOfWork (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:9148:16)
    at workLoopSync (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:9046:39)
    at renderRootSync (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:9030:9)
    at performWorkOnRoot (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:8705:42)
    at performWorkOnRootViaSchedulerTask (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:9703:5)
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 99
- **screenshot quality issues:** none

## mobile

- **verdict:** needs-eyeball
- **console errors:** Error: useAuth must be used within a <StewardProvider> with an `auth` prop.
    at useAuth (http://127.0.0.1:59796/assets/vendor-crypto-C3acyo1E.js:53131:11)
    at AuthorizeAuthenticatedContent (http://127.0.0.1:59796/assets/vendor-crypto-C3acyo1E.js:108915:7)
    at renderWithHooks (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:4142:23)
    at updateFunctionComponent (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:5771:17)
    at beginWork (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:6382:16)
    at performUnitOfWork (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:9148:16)
    at workLoopSync (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:9046:39)
    at renderRootSync (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:9030:9)
    at performWorkOnRoot (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:8705:42)
    at performWorkOnRootViaSchedulerTask (http://127.0.0.1:59796/assets/vendor-react-CGhIJj0G.js:9703:5)
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 99
- **screenshot quality issues:** none

## Hand review

HARNESS LIMITATION - not gradeable here: with VITE_PLAYWRIGHT_TEST_AUTH baked, StewardAuthProvider renders children without the Steward runtime, so AuthorizeContent's useAuth() throws and the error boundary shows 'Something went wrong'. Production mounts the runtime for /app-auth (#9881 fixed + covers that wiring). Needs a runtime-backed capture in a follow-up; the recorded console error is the expected artifact of this environment.

_Reviewed by hand from the committed desktop + mobile screenshots (run 3, 85/85 green). Machine scan (report.json): no blue, no orange-hover violations, no console errors on this page unless noted above._
