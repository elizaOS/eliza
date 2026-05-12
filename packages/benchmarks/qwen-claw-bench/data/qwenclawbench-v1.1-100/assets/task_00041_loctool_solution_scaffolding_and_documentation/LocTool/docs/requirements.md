# LocTool — Solution Requirements Specification

**Document Version:** 2.1  
**Last Updated:** 2024-02-28  
**Author:** Sarah Chen, Lead Architect  
**Status:** Approved

---

## 1. Overview

LocTool is a desktop localization management tool built with WPF. It enables translation teams to import, edit, and export localization resource files using Excel spreadsheets as the interchange format. The application follows the MVVM (Model-View-ViewModel) architectural pattern and uses dependency injection for service resolution.

---

## 2. Solution Structure

The solution **LocTool.sln** consists of **4 projects**:

| # | Project Name         | Type            | Output Type   | Description                                      |
|---|----------------------|-----------------|---------------|--------------------------------------------------|
| 1 | **LocTool.App**      | WPF Application | Exe           | Presentation layer — XAML views, App startup, DI configuration |
| 2 | **LocTool.Core**     | Class Library   | Library (DLL) | Business logic, Excel processing services, data models, interfaces |
| 3 | **LocTool.ViewModel**| Class Library   | Library (DLL) | MVVM ViewModels, commands, observable properties  |
| 4 | **LocTool.Tests**    | xUnit Test Project | Library (DLL) | Unit tests for Core and ViewModel layers         |

---

## 3. Target Framework

All projects **MUST** target:

```
net8.0-windows
```

> **Important:** The `-windows` target framework moniker (TFM) suffix is required because the solution uses WPF, which is a Windows-only UI framework. Using `net8.0` alone will cause build failures for any project that directly or transitively references WPF assemblies.

---

## 4. Project References (Dependency Graph)

```
LocTool.App
  ├── references → LocTool.ViewModel
  └── references → LocTool.Core

LocTool.ViewModel
  └── references → LocTool.Core

LocTool.Tests
  ├── references → LocTool.Core
  └── references → LocTool.ViewModel
```

- **LocTool.App** depends on both **LocTool.ViewModel** and **LocTool.Core**.
- **LocTool.ViewModel** depends on **LocTool.Core** only.
- **LocTool.Tests** depends on **LocTool.Core** and **LocTool.ViewModel** (to test both layers).
- **LocTool.Core** has no project references (it is the bottom layer).

---

## 5. NuGet Package Requirements

### 5.1 Dependency Injection

- **Package:** `Microsoft.Extensions.DependencyInjection`  
- **Version:** `8.0.0`  
- **Used in:** `LocTool.App`  
- **Purpose:** Service registration and resolution via `IServiceProvider`. All services defined in LocTool.Core are registered in the DI container during application startup.

### 5.2 Excel Processing

- **Package:** `EPPlus`  
- **Version:** per current baseline NuGet version registry in `config/`  
- **Used in:** `LocTool.Core`  
- **Purpose:** Reading and writing `.xlsx` files for localization resource import/export.

> **License Requirement:** EPPlus 5+ requires explicit license context configuration. For this project (non-commercial/internal tool), the following **MUST** be set in `App.xaml.cs` in the `OnStartup` method **before** any EPPlus API call:
>
> ```csharp
> OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.NonCommercial;
> ```

### 5.3 MVVM Toolkit

- **Package:** `CommunityToolkit.Mvvm`  
- **Version:** per current baseline NuGet version registry in `config/`  
- **Used in:** `LocTool.ViewModel`  
- **Purpose:** Provides `ObservableObject` base class, `[ObservableProperty]` and `[RelayCommand]` source generators for clean MVVM implementation.

### 5.4 Testing Packages

The test project uses xunit as the testing framework with the following supporting packages:

- `xunit` — Test framework
- `xunit.runner.visualstudio` — Visual Studio test runner adapter
- `Microsoft.NET.Test.Sdk` — Test platform infrastructure
- `Moq` — Mocking framework
- `coverlet.collector` — Code coverage collection

**Used in:** `LocTool.Tests`

> Exact version numbers for all testing packages — including `coverlet.collector` — are maintained in the NuGet version registry (`config/`). Use the current baseline registry; do not use deprecated, draft, or pre-release versions.

---

## 6. Application Startup Sequence

The `App.xaml.cs` file in **LocTool.App** must perform the following in `OnStartup`:

1. **Set EPPlus License Context:**
   ```csharp
   OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.NonCommercial;
   ```

2. **Configure Dependency Injection:**
   ```csharp
   var services = new ServiceCollection();
   // Register Core services
   services.AddSingleton<ILocalizationService, LocalizationService>();
   services.AddSingleton<IExcelService, ExcelService>();
   // Register ViewModels
   services.AddTransient<MainViewModel>();
   var serviceProvider = services.BuildServiceProvider();
   ```

3. **Create and show MainWindow** with the resolved `MainViewModel` as its `DataContext`.

---

## 7. MVVM Pattern Guidelines

- All ViewModels reside in the **LocTool.ViewModel** project.
- ViewModels inherit from `ObservableObject` (from CommunityToolkit.Mvvm).
- Use `[ObservableProperty]` attribute for bindable properties.
- Use `[RelayCommand]` attribute for command implementations.
- Views (XAML) reside in **LocTool.App** and bind to ViewModels via `DataContext`.
- No code-behind logic in views except for unavoidable WPF plumbing.

---

## 8. Non-Functional Requirements

- The solution must build with `dotnet build` from the command line.
- All projects use C# latest language version (`LangVersion=latest`).
- Nullable reference types are enabled (`Nullable=enable`).
- Implicit usings are enabled (`ImplicitUsings=enable`).
- All compiler warnings are treated as errors (`TreatWarningsAsErrors=true`).

---

## 9. NuGet Source Configuration

The team uses a private Contoso NuGet feed alongside the public nuget.org registry. A `NuGet.config` file must be present at the solution root to configure both package sources:

- **nuget.org**: `https://api.nuget.org/v3/index.json`
- **Contoso Internal**: `https://pkgs.contoso.com/nuget/v3/index.json`

The Contoso feed hosts internal shared libraries used across the organization. While LocTool does not currently consume any private packages, the feed must be configured to support future integration.

---

*End of Requirements Document*
