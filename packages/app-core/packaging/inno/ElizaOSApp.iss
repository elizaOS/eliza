#define MyAppId "__APP_ID__"
#define MyAppName "__APP_NAME__"
#define MyAppVersion "__APP_VERSION__"
#define MyAppPublisher "elizaOS"
#define MyAppExeName "bin\launcher.exe"
#define MyDefaultDirName "__DEFAULT_DIR_NAME__"
#define MyDefaultGroupName "__DEFAULT_GROUP_NAME__"
#define MyOutputDir "__OUTPUT_DIR__"
#define MyOutputBaseFilename "__OUTPUT_BASE_FILENAME__"
#define MySourceDir "__SOURCE_DIR__"
#define MySetupIconFile "__ICON_FILE__"
#define MyAppIconFile "ElizaOSApp.ico"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://app.elizaos.ai
AppSupportURL=https://github.com/elizaos/elizaos-app/issues
AppUpdatesURL=https://github.com/elizaos/elizaos-app/releases
DefaultDirName={#MyDefaultDirName}
DefaultGroupName={#MyDefaultGroupName}
DisableProgramGroupPage=yes
OutputDir={#MyOutputDir}
OutputBaseFilename={#MyOutputBaseFilename}
SetupIconFile={#MySetupIconFile}
UninstallDisplayIcon={app}\{#MyAppIconFile}
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
WizardStyle=modern
SetupLogging=yes
CloseApplications=no
RestartIfNeededByRun=no
__SIGN_SETUP_LINES__

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MySetupIconFile}"; DestDir: "{app}"; DestName: "{#MyAppIconFile}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyDefaultGroupName}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppIconFile}"
Name: "{autoprograms}\{#MyDefaultGroupName}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; IconFilename: "{app}\{#MyAppIconFile}"
