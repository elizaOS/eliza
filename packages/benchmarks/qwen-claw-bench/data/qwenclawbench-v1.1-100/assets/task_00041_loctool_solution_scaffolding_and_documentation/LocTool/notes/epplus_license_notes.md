# EPPlus Licensing Notes

**Applies to:** EPPlus version 5.0.0 and later (including 7.x)  
**Last Reviewed:** 2024-02-28

---

## Background

Starting with **EPPlus 5.0**, the library transitioned from LGPL to a dual-license model:

1. **Polyform Noncommercial License** — Free for non-commercial use.
2. **Commercial License** — Required for commercial use (paid).

As a consequence, EPPlus 5+ **requires** that you explicitly set the `LicenseContext` property before making any EPPlus API calls. Failure to do so will result in a `LicenseException` being thrown at runtime.

---

## Required Configuration

### For Non-Commercial Use

Set the license context to `NonCommercial` **before** any EPPlus operations:

```csharp
OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.NonCommercial;
```

### For Commercial Use

```csharp
OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.Commercial;
```

---

## Where to Set It (WPF Application)

For a WPF application, the license context **must** be set in the `App.xaml.cs` file, inside the `OnStartup` method. This ensures it is configured before any service or ViewModel attempts to use EPPlus.

```csharp
// App.xaml.cs
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // MUST be set before any EPPlus API call
        OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.NonCommercial;

        // ... rest of startup (DI configuration, etc.)
    }
}
```

---

## Common Mistake

If you forget to set the `LicenseContext`, you will see the following exception at runtime:

```
OfficeOpenXml.LicenseException:
Please set the ExcelPackage.LicenseContext property.
See https://epplussoftware.com/developers/licenseexception
```

This exception is thrown the first time you create an `ExcelPackage` instance or call any EPPlus API.

---

## Alternative: Environment Variable

You can also set the license context via an environment variable instead of code:

```
EPPlus:ExcelPackage.LicenseContext=NonCommercial
```

However, for LocTool we use the code-based approach in `App.xaml.cs` as specified in the requirements document.

---

## References

- [EPPlus License FAQ](https://epplussoftware.com/en/LicenseOverview)
- [EPPlus 5.0 Migration Guide](https://epplussoftware.com/en/Developers)

---

*End of EPPlus License Notes*
