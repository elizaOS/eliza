# Safari Extension - Chat with Webpage

This directory contains instructions for building the Safari version of the Chat with Webpage extension.

## Overview

Safari extensions are built using the same Web Extension APIs as Chrome, but they need to be wrapped in a native macOS/iOS app container. Apple provides a tool to convert Chrome extensions to Safari format.

## Prerequisites

1. **macOS** with Xcode installed (from the App Store)
2. **Apple Developer account** (free tier works for local development)
3. The **Chrome extension built** first (run `npm run build` in the `chrome/` directory)

## Building the Safari Extension

### Step 1: Build the Chrome Extension First

```bash
cd ../chrome
npm install
npm run build
```

### Step 2: Convert to Safari Extension

Apple provides the `xcrun safari-web-extension-converter` tool that comes with Xcode. Run it from the terminal:

```bash
# Navigate to the browser-extension directory
cd /path/to/examples/browser-extension

# Convert the Chrome extension to Safari
xcrun safari-web-extension-converter chrome \
  --project-location safari \
  --app-name "Chat with Webpage" \
  --bundle-identifier com.elizaos.chatwithwebpage \
  --swift
```

This will create an Xcode project in the `safari/` directory.

### Step 3: Open in Xcode

```bash
open safari/Chat\ with\ Webpage/Chat\ with\ Webpage.xcodeproj
```

### Step 4: Configure Signing

1. In Xcode, select the project in the navigator
2. Select the app target
3. Go to "Signing & Capabilities"
4. Select your development team
5. Xcode will automatically manage signing

### Step 5: Build and Run

1. Select "My Mac" as the run destination
2. Click the Run button (⌘R) to build and install the extension
3. Safari will launch automatically

### Step 6: Enable the Extension in Safari

1. Open Safari
2. Go to Safari > Settings (or Preferences)
3. Click the "Extensions" tab
4. Find "Chat with Webpage" and enable it
5. Grant the necessary permissions when prompted

## Development Tips

### Debugging

- In Safari, go to Develop > Web Extension Background Pages > Chat with Webpage
- This opens the Web Inspector for debugging the background script
- You can also debug content scripts and popup from the Develop menu

### Hot Reload

During development, you can enable automatic reloading:

1. In Safari, go to Develop > Allow Unsigned Extensions
2. Any changes to the extension files will be picked up when you reload Safari

### Testing on iOS

The same Xcode project can build for iOS:

1. Select an iOS Simulator or connected device as the run destination
2. Build and run
3. On iOS, go to Settings > Safari > Extensions to enable

## Troubleshooting

### "Cannot find 'chrome' module"

Safari uses the `browser` namespace by default. The converter tool usually handles this, but if you see errors:

- Ensure you're using the standard WebExtension APIs
- The `browser` and `chrome` namespaces are compatible in Safari

### Extension not appearing in Safari

1. Make sure "Allow Unsigned Extensions" is enabled in Safari's Develop menu
2. Check that the app was properly signed
3. Try quitting and reopening Safari

### Permission errors

Safari requires explicit user permission for:
- activeTab access
- Storage
- Host permissions

Users need to grant these in Safari Settings > Extensions.

## File Structure After Conversion

```
safari/
└── Chat with Webpage/
    ├── Chat with Webpage.xcodeproj
    ├── iOS (App)/
    │   └── ... iOS app wrapper files
    ├── macOS (App)/
    │   └── ... macOS app wrapper files
    └── Shared (Extension)/
        ├── manifest.json
        ├── Resources/
        │   ├── background.js
        │   ├── content.js
        │   ├── popup.html
        │   ├── popup.css
        │   ├── popup.js
        │   └── icons/
        └── ... other extension files
```

## Resources

- [Apple's Safari Web Extension Documentation](https://developer.apple.com/documentation/safariservices/safari_web_extensions)
- [Converting a Chrome Extension to Safari](https://developer.apple.com/documentation/safariservices/safari_web_extensions/converting_a_web_extension_for_safari)
- [Safari Web Extension Guide](https://developer.apple.com/documentation/safariservices/safari_web_extensions/building_a_safari_web_extension)
