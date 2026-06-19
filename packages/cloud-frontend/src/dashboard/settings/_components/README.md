# Settings Page Implementation

This is the implementation of the Settings page based on the Figma design.

## Figma Source

**Design URL:** https://www.figma.com/design/64xmxXKnD8cATGW2D0Zm17/Eliza-Cloud-App?m=dev&focus-id=435-3215

## Page Location

`/dashboard/settings`

## Component Structure

```
app/dashboard/settings/
  └── page.tsx                    # Server component with auth

components/settings/
  ├── settings-page-client.tsx    # Main client component with tab state
  ├── settings-tabs.tsx            # Tab navigation component
  └── tabs/
      ├── index.ts                 # Barrel export
      ├── general-tab.tsx          # General settings (fully implemented)
      ├── account-tab.tsx          # Account settings, stats, and logout
      ├── usage-tab.tsx            # Credits, quotas, and session usage
      ├── billing-tab.tsx          # Credit purchases, invoices, and auto top-up
      ├── apis-tab.tsx             # API key management
      └── analytics-tab.tsx        # Usage analytics and metrics
```

## Features Implemented

### Tab Navigation

- ✅ 6 tabs: General, Account, Usage, Billing, APIs, Analytics
- ✅ Icons from `lucide-react` matching Figma design
- ✅ Active state styling with white bottom border
- ✅ Hover effects
- ✅ Responsive overflow handling

### General Tab (Fully Implemented)

**Profile Information Card:**

- ✅ Full name field with avatar initials
- ✅ Nickname field
- ✅ Work function dropdown selector
- ✅ Personal preferences textarea
- ✅ Save changes button with pattern overlay
- ✅ Corner brackets decoration

**Notification Settings Card:**

- ✅ Response completions toggle switch
- ✅ Email notifications toggle switch
- ✅ Orange accent color (#FF5800) for active switches
- ✅ Corner brackets decoration

### Account Tab

- ✅ Organization ID copy action
- ✅ Account statistics fetch
- ✅ Recent activity and quick links
- ✅ Logout flow with Steward session cleanup

### Usage Tab

- ✅ Credit balance and daily burn display
- ✅ Current session statistics
- ✅ Quota usage by model/provider
- ✅ Periodic session refresh

### Billing Tab

- ✅ Credit purchase flow
- ✅ Card and crypto payment options
- ✅ Invoice listing
- ✅ Auto top-up controls

### APIs Tab

- ✅ API key listing
- ✅ API key creation dialog
- ✅ One-time key reveal and copy flow
- ✅ Delete confirmation

### Analytics Tab

- ✅ Time range selector
- ✅ Cadence and focus metric controls
- ✅ Request, cost, token, and success-rate summaries

## Design System Integration

### Components Used

- `BrandCard` - Card container with dark styling
- `CornerBrackets` - Decorative corner elements
- `Input` - shadcn/ui input component
- `Label` - shadcn/ui label component
- `Textarea` - shadcn/ui textarea component
- `Select` - shadcn/ui select component
- `Switch` - shadcn/ui switch component

### Icons

All icons use `lucide-react`:

- `User` - General tab
- `Building2` - Account tab
- `BarChart3` - Usage tab
- `CreditCard` - Billing tab
- `Key` - APIs tab
- `PieChart` - Analytics tab

### Color Palette

- Background: `bg-transparent`, `bg-neutral-950`
- Borders: `border-[#303030]`, `border-brand-surface`
- Text: `text-white`, `text-[#858585]`, `text-white/60`
- Accent: `#FF5800` (orange)
- Active states: `bg-[rgba(255,255,255,0.07)]`

## Assets

All Figma assets are stored in `/public/assets/settings/`

- Logo, icons, patterns, and decorative elements
- See `/public/assets/settings/README.md` for details

## Usage Example

```tsx
// Access the page at:
// http://localhost:3000/dashboard/settings

// The page automatically:
// 1. Requires authentication
// 2. Loads user data
// 3. Shows General tab by default
// 4. Persists user preferences
```

## Maintenance Notes

- Keep tab copy and endpoint references synchronized with the dashboard data
  hooks and Cloud API DTOs.
- Run the cloud visual-review protocol for UI changes in this directory:
  `bun run --cwd packages/cloud-frontend audit:cloud`.
- Run typecheck and targeted tests after changing tab behavior.

## Testing

To test the page:

```bash
# Start the development server
bun run dev

# Navigate to:
http://localhost:3000/dashboard/settings
```

Make sure you're authenticated to access the page.
