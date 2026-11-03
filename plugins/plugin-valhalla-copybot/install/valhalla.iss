; Valhalla desk installer. TokenJunction LLC is the publisher.
; This script does not contain a street address or a tax id.

#define MyAppName "Valhalla"
#define MyAppVersion "0.1.1"
#define MyAppPublisher "TokenJunction LLC"
#define MyAppURL "https://valhalla-app.xyz/"

[Setup]
SetupIconFile=valhalla.ico
AppId={{7C3E9A10-4B2D-4F61-9C0A-202611030001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppCopyright=Copyright 2026 TokenJunction LLC
DefaultDirName={autopf}\Valhalla
DefaultGroupName=Valhalla
OutputBaseFilename=Valhalla-Setup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
WizardStyle=modern

[Files]
; Point Source at the built desk when you compile this script on your PC.
; Do not commit a wallet, a key, or the bot token.

[Icons]
Name: "{group}\Valhalla"; Filename: "{app}\Valhalla.exe"; Comment: "Published by TokenJunction LLC"
