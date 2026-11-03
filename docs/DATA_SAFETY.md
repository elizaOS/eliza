# Play Data safety answers

TokenJunction LLC is the publisher. Use these answers in Play Console. Change them if you later add an account or a server copy. Do not put a street address or an EIN in this file.

## Data collection

The app does not create a user account.

Data stored only on the phone:

- App interactions: the desk address, access code, last status, chat, and error log. Not shared. User can delete it in the app.
- Device or other IDs: the Android advertising ID, only if ads are on, collected by Google AdMob. Shared with Google. Users can reset it in Android settings.

Not collected by us:

- Name, email, phone number
- Precise or coarse location
- Photos, files, or contacts
- Financial info, including wallet keys or bank data
- Messages, other than the chat text sent to the desk the user typed in

## Ads declaration

The app contains ads when `ADS_ENABLED` is true. The default build uses Google's test ad units. Declare ads in the Play Console before you ship a build that can show ads.

## Security

Data on the phone is in the app's private storage. Traffic to the desk uses the address the user enters. Do not claim encryption beyond Android's private storage unless you add it.

## Data deletion

There is no account. Tell Play: users delete data in the app with Delete phone data. You do not need a web deletion URL for an account you do not have. If Play still asks for a URL, use the privacy policy page and state that deletion is in the app.

## Target audience

18 and older. The app is not for children. Do not opt in to Designed for Families.
