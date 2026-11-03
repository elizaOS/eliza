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
OutputBaseFilename=valhalla-setup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
WizardStyle=modern

[Files]
Source: "dist\valhalla-desk.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs
Source: "start-valhalla.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "valhalla.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Valhalla"; Filename: "{app}\start-valhalla.bat"; Comment: "Published by TokenJunction LLC"
Name: "{autodesktop}\Valhalla"; Filename: "{app}\start-valhalla.bat"; Comment: "Published by TokenJunction LLC"
