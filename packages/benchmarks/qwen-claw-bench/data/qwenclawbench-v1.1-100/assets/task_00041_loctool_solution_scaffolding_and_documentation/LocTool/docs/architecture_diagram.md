# LocTool — Architecture Diagram

**Document Version:** 1.2  
**Last Updated:** 2024-03-18

---

## Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      PRESENTATION LAYER                         │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    LocTool.App                           │   │
│   │                  (WPF Application)                       │   │
│   │                                                         │   │
│   │  • App.xaml.cs — Startup, DI configuration,             │   │
│   │                  EPPlus license setup                    │   │
│   │  • MainWindow.xaml — Primary application window         │   │
│   │  • Views/*.xaml — User interface views                  │   │
│   │  • Output Type: Exe                                     │   │
│   │  • Target: net8.0-windows                               │   │
│   └──────────┬──────────────────────┬───────────────────────┘   │
│              │                      │                           │
│              │ references           │ references                │
│              ▼                      ▼                           │
├─────────────────────────────────────────────────────────────────┤
│                        MVVM LAYER                               │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                 LocTool.ViewModel                        │   │
│   │                 (Class Library)                          │   │
│   │                                                         │   │
│   │  • MainViewModel.cs — Primary view model                │   │
│   │  • ImportViewModel.cs — Excel import workflow           │   │
│   │  • ExportViewModel.cs — Excel export workflow           │   │
│   │  • Base: ObservableObject (CommunityToolkit.Mvvm)       │   │
│   │  • Target: net8.0-windows                               │   │
│   └──────────────────────┬──────────────────────────────────┘   │
│                          │                                      │
│                          │ references                           │
│                          ▼                                      │
├─────────────────────────────────────────────────────────────────┤
│                     BUSINESS LOGIC LAYER                        │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    LocTool.Core                          │   │
│   │                  (Class Library)                         │   │
│   │                                                         │   │
│   │  • Services/                                            │   │
│   │    ├── ILocalizationService.cs                          │   │
│   │    ├── LocalizationService.cs                           │   │
│   │    ├── IExcelService.cs                                 │   │
│   │    └── ExcelService.cs  (uses EPPlus 7.1.0)            │   │
│   │  • Models/                                              │   │
│   │    ├── LocalizationEntry.cs                             │   │
│   │    └── ResourceFile.cs                                  │   │
│   │  • Logging via ILogger<T>                               │   │
│   │    (Microsoft.Extensions.Logging.Abstractions 8.0.1)    │   │
│   │  • Target: net8.0-windows                               │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────┐
│                        TEST LAYER                               │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   LocTool.Tests                          │   │
│   │               (xUnit Test Project)                       │   │
│   │                                                         │   │
│   │  • CoreTests/ — Unit tests for LocTool.Core             │   │
│   │  • ViewModelTests/ — Unit tests for LocTool.ViewModel   │   │
│   │  • Uses: xunit 2.8.0, Moq 4.20.72                      │   │
│   │  • Target: net8.0-windows                               │   │
│   └──────────┬──────────────────────┬───────────────────────┘   │
│              │                      │                           │
│              │ references           │ references                │
│              ▼                      ▼                           │
│        LocTool.Core          LocTool.ViewModel                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Dependency Graph (Simplified)

```
    LocTool.App ──────────► LocTool.ViewModel
        │                        │
        │                        │
        └────────┐               │
                 ▼               ▼
             LocTool.Core ◄──────┘

    LocTool.Tests ──────────► LocTool.Core
        │
        └───────────────────► LocTool.ViewModel
```

---

## Key NuGet Dependencies by Project

```
LocTool.App
  ├── Microsoft.Extensions.DependencyInjection  8.0.1
  ├── [ProjectRef] LocTool.ViewModel
  └── [ProjectRef] LocTool.Core

LocTool.ViewModel
  ├── CommunityToolkit.Mvvm  8.3.0
  └── [ProjectRef] LocTool.Core

LocTool.Core
  ├── EPPlus  7.1.0
  └── Microsoft.Extensions.Logging.Abstractions  8.0.1

LocTool.Tests
  ├── xunit  2.8.0
  ├── xunit.runner.visualstudio  2.5.8
  ├── Microsoft.NET.Test.Sdk  17.10.0
  ├── Moq  4.20.72
  ├── coverlet.collector  6.0.2
  ├── [ProjectRef] LocTool.Core
  └── [ProjectRef] LocTool.ViewModel
```

---

*End of Architecture Diagram*
