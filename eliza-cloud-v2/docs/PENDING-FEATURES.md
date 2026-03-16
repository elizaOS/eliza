# Pending Features

## Landing Page - Discover Sections

### Current State

The agents and apps displayed in the landing page discover sections are **placeholders/mock data**.

### Required Changes

1. **Fetch real data from database**
   - Replace mock agents with actual public/featured agents from the database
   - Replace mock apps with actual public/featured apps from the database
   - Add API endpoints to fetch public agents/apps (e.g., `/api/v1/agents/public`, `/api/v1/apps/public`)

2. **Public Pages for "View All"**
   - Create `/agents` - Public page showing all available agents
   - Create `/apps` - Public page showing all available apps
   - These pages should be accessible without authentication
   - Link the "View All" buttons in landing page discover sections to these pages

---

## Landing Page Chatbox - localStorage Auto-Load

### Current Behavior

- User types a prompt in the landing page hero chatbox
- User selects mode: "App" or "Agent"
- On submit, data is saved to localStorage with key `hero-chat-input`:
  ```json
  { "prompt": "user's prompt text", "mode": "app" | "agent" }
  ```
- User is redirected to signup/login
- **Currently**: The saved data is not used after login

### Required Implementation

1. **Dashboard Entry Point Detection**
   - When user logs in and lands on dashboard, check for `hero-chat-input` in localStorage
   - Read the saved `{ prompt, mode }` data

2. **Auto-Load Based on Mode**
   - **If `mode === "app"`**:
     - When user navigates to app creation with AI (e.g., `/dashboard/apps/create` or similar AI builder)
     - Auto-populate the chatbox/prompt input with the saved `prompt`
     - Clear `hero-chat-input` from localStorage after loading

   - **If `mode === "agent"`**:
     - When user navigates to agent creation with AI (e.g., `/dashboard/agents/create` or character builder)
     - Auto-populate the chatbox/prompt input with the saved `prompt`
     - Clear `hero-chat-input` from localStorage after loading

3. **Implementation Location**
   - Add check in dashboard layout or relevant builder components
   - Use a custom hook like `useHeroPrompt()` that:

     ```tsx
     function useHeroPrompt(targetMode: "app" | "agent") {
       const [savedPrompt, setSavedPrompt] = useState<string | null>(null);

       useEffect(() => {
         const saved = localStorage.getItem("hero-chat-input");
         if (saved) {
           const { prompt, mode } = JSON.parse(saved);
           if (mode === targetMode) {
             setSavedPrompt(prompt);
             localStorage.removeItem("hero-chat-input");
           }
         }
       }, [targetMode]);

       return savedPrompt;
     }
     ```

4. **Files to Modify**
   - App builder component (where AI creates apps)
   - Agent/Character builder component (where AI creates agents)
   - Potentially dashboard layout for routing logic

---

## Priority

1. localStorage auto-load (quick win, improves onboarding UX)
2. Public agents/apps pages
3. Real data in landing page discover sections
