# C# Coding Standards & Best Practices

**Document Version:** 4.1  
**Last Updated:** 2024-02-20  
**Applies to:** All C# projects at Contoso Engineering

---

## Table of Contents

1. [Naming Conventions](#1-naming-conventions)
2. [Code Formatting](#2-code-formatting)
3. [Type Design Guidelines](#3-type-design-guidelines)
4. [Exception Handling](#4-exception-handling)
5. [Logging Patterns](#5-logging-patterns)
6. [Async/Await Best Practices](#6-asyncawait-best-practices)
7. [MVVM Pattern Guidelines](#7-mvvm-pattern-guidelines)
8. [Unit Testing Standards](#8-unit-testing-standards)
9. [Code Review Checklist](#9-code-review-checklist)
10. [Performance Considerations](#10-performance-considerations)

---

## 1. Naming Conventions

### 1.1 General Rules

- **PascalCase** for: classes, methods, properties, events, namespaces, enum values, public fields.
- **camelCase** for: local variables, method parameters.
- **_camelCase** (underscore prefix) for: private fields.
- **UPPER_SNAKE_CASE**: Do NOT use. This is not a C# convention.
- **I-prefix** for interfaces: `ILocalizationService`, `IExcelService`.

### 1.2 Specific Naming Patterns

| Element          | Convention       | Example                        |
|------------------|------------------|--------------------------------|
| Class            | PascalCase noun  | `LocalizationService`          |
| Interface        | I + PascalCase   | `ILocalizationService`         |
| Method           | PascalCase verb  | `LoadResources()`              |
| Property         | PascalCase noun  | `FileName`                     |
| Private field    | _camelCase       | `_localizationService`         |
| Local variable   | camelCase        | `resourceCount`                |
| Constant         | PascalCase       | `MaxRetryCount`                |
| Enum type        | PascalCase       | `ExportFormat`                 |
| Enum value       | PascalCase       | `ExportFormat.Xlsx`            |
| Event            | PascalCase       | `FileLoaded`                   |
| Async method     | PascalCase + Async suffix | `LoadResourcesAsync()` |

### 1.3 Abbreviations

- Avoid abbreviations unless universally understood (e.g., `Id`, `Url`, `Html`).
- Two-letter abbreviations are uppercase: `IO`, `UI`.
- Three+ letter abbreviations use PascalCase: `Xml`, `Json`, `Http`.

---

## 2. Code Formatting

### 2.1 Indentation and Spacing

- Use **4 spaces** for indentation (no tabs).
- Opening braces on a **new line** (Allman style):

```csharp
// Correct
if (condition)
{
    DoSomething();
}

// Wrong
if (condition) {
    DoSomething();
}
```

### 2.2 Line Length

- Maximum line length: **120 characters**.
- Break long lines at logical points (after commas, before operators).

### 2.3 Blank Lines

- One blank line between methods.
- One blank line between property groups and method groups.
- No multiple consecutive blank lines.
- No blank line after opening brace or before closing brace.

### 2.4 Using Directives

- Place `using` directives at the top of the file, outside the namespace.
- Sort alphabetically, with `System` namespaces first.
- Remove unused `using` directives.

```csharp
using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Extensions.DependencyInjection;
using LocTool.Core.Models;
```

---

## 3. Type Design Guidelines

### 3.1 Class Design

- Prefer **sealed** classes unless inheritance is explicitly needed.
- Use `readonly` for fields that don't change after construction.
- Prefer composition over inheritance.
- Keep classes focused — Single Responsibility Principle.

### 3.2 Record Types

- Use `record` types for immutable data transfer objects.
- Use `record struct` for small value types.

```csharp
public record LocalizationEntry(string Key, string Value, string Culture);
```

### 3.3 Interface Design

- Keep interfaces small and focused (Interface Segregation Principle).
- Prefer multiple small interfaces over one large interface.
- Document the contract with XML comments.

---

## 4. Exception Handling

### 4.1 General Rules

- **Never** catch `Exception` without re-throwing or logging.
- **Never** use empty catch blocks.
- Catch the most specific exception type possible.
- Use `when` clause for conditional catching.

```csharp
try
{
    var package = new ExcelPackage(fileInfo);
    // process...
}
catch (InvalidOperationException ex) when (ex.Message.Contains("LicenseContext"))
{
    _logger.LogError(ex, "EPPlus license context not configured");
    throw;
}
catch (IOException ex)
{
    _logger.LogError(ex, "Failed to read Excel file: {FileName}", fileInfo.Name);
    throw new FileProcessingException($"Cannot read file: {fileInfo.Name}", ex);
}
```

### 4.2 Custom Exceptions

- Derive from `Exception` (not `ApplicationException`).
- Include standard constructors (parameterless, message, message + inner).
- Name with `Exception` suffix.

### 4.3 Validation

- Use guard clauses at method entry points.
- Prefer `ArgumentNullException.ThrowIfNull()` (.NET 6+).
- Prefer `ArgumentException.ThrowIfNullOrEmpty()` (.NET 8+).

```csharp
public void LoadFile(string filePath)
{
    ArgumentException.ThrowIfNullOrEmpty(filePath);
    // ...
}
```

---

## 5. Logging Patterns

### 5.1 Structured Logging

- Use structured logging with message templates (not string interpolation).
- Use `ILogger<T>` from `Microsoft.Extensions.Logging`.

```csharp
// Correct
_logger.LogInformation("Processing file {FileName} with {EntryCount} entries", fileName, count);

// Wrong
_logger.LogInformation($"Processing file {fileName} with {count} entries");
```

### 5.2 Log Levels

| Level       | Usage                                                    |
|-------------|----------------------------------------------------------|
| Trace       | Detailed diagnostic information                          |
| Debug       | Development-time diagnostic information                  |
| Information | General application flow                                 |
| Warning     | Unexpected events that don't cause failure               |
| Error       | Errors that prevent a specific operation                 |
| Critical    | Unrecoverable errors requiring immediate attention       |

### 5.3 What to Log

- Application startup and shutdown.
- Configuration values (sanitized — no secrets).
- External service calls (start, duration, result).
- Business rule violations.
- Exception details at Error or Critical level.

---

## 6. Async/Await Best Practices

- Use `async`/`await` for I/O-bound operations.
- **Always** use `Async` suffix for async methods.
- **Never** use `async void` except for event handlers.
- Use `ConfigureAwait(false)` in library code (LocTool.Core).
- Do NOT use `ConfigureAwait(false)` in UI code (LocTool.App) — it needs the synchronization context.
- Prefer `ValueTask<T>` for hot paths that frequently complete synchronously.

```csharp
// In LocTool.Core (library)
public async Task<List<LocalizationEntry>> LoadEntriesAsync(string filePath)
{
    await using var stream = File.OpenRead(filePath);
    using var package = new ExcelPackage(stream);
    // ... process
    return entries;
}
```

---

## 7. MVVM Pattern Guidelines

> **This section applies specifically to WPF projects using the MVVM pattern.**

### 7.1 ViewModel Base Class

All ViewModels **must** inherit from `ObservableObject` provided by **CommunityToolkit.Mvvm** (version 8.3.0). Do NOT create custom base classes or use third-party MVVM frameworks.

```csharp
using CommunityToolkit.Mvvm.ComponentModel;

public partial class MainViewModel : ObservableObject
{
    // ...
}
```

### 7.2 Observable Properties

Use the `[ObservableProperty]` source generator attribute instead of manually implementing `INotifyPropertyChanged`:

```csharp
public partial class MainViewModel : ObservableObject
{
    [ObservableProperty]
    private string _statusMessage = string.Empty;

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private ObservableCollection<LocalizationEntry> _entries = new();
}
```

### 7.3 Commands

Use the `[RelayCommand]` attribute to generate `ICommand` implementations:

```csharp
public partial class MainViewModel : ObservableObject
{
    [RelayCommand]
    private async Task LoadFileAsync(string filePath)
    {
        IsLoading = true;
        try
        {
            var entries = await _localizationService.LoadEntriesAsync(filePath);
            Entries = new ObservableCollection<LocalizationEntry>(entries);
            StatusMessage = $"Loaded {entries.Count} entries.";
        }
        finally
        {
            IsLoading = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanExport))]
    private async Task ExportAsync()
    {
        // ...
    }

    private bool CanExport => Entries.Count > 0;
}
```

### 7.4 View-ViewModel Binding

- Set `DataContext` in code-behind or via DI, not in XAML.
- Views should have minimal code-behind (only unavoidable WPF plumbing).
- Use `{Binding}` markup extension for data binding.
- Use `{x:Bind}` is NOT available in WPF (that's WinUI/UWP).

---

## 8. Unit Testing Standards

### 8.1 Test Naming

Use the pattern: `MethodName_Scenario_ExpectedResult`

```csharp
[Fact]
public void LoadEntries_WithValidExcelFile_ReturnsExpectedEntries()
{
    // ...
}

[Fact]
public void LoadEntries_WithEmptyFile_ReturnsEmptyList()
{
    // ...
}
```

### 8.2 Test Structure

Follow the **Arrange-Act-Assert** pattern:

```csharp
[Fact]
public async Task ExportAsync_WithEntries_CreatesExcelFile()
{
    // Arrange
    var mockService = new Mock<IExcelService>();
    var viewModel = new MainViewModel(mockService.Object);
    viewModel.Entries.Add(new LocalizationEntry("key1", "value1", "en-US"));

    // Act
    await viewModel.ExportCommand.ExecuteAsync(null);

    // Assert
    mockService.Verify(s => s.ExportAsync(It.IsAny<IEnumerable<LocalizationEntry>>(), It.IsAny<string>()), Times.Once);
}
```

### 8.3 Mocking

- Use **Moq** for creating test doubles.
- Mock interfaces, not concrete classes.
- Verify interactions when testing behavior, assert state when testing logic.

---

## 9. Code Review Checklist

Before submitting a pull request, verify:

- [ ] Code compiles without warnings.
- [ ] All new public members have XML documentation comments.
- [ ] Naming conventions are followed consistently.
- [ ] No magic numbers — use named constants.
- [ ] Exception handling is appropriate (no swallowed exceptions).
- [ ] Async methods follow best practices.
- [ ] Unit tests cover new functionality.
- [ ] No commented-out code.
- [ ] No `TODO` comments without linked work items.

---

## 10. Performance Considerations

### 10.1 String Operations

- Use `StringBuilder` for concatenating more than ~5 strings.
- Use `string.Create` or `Span<char>` for performance-critical string operations.
- Prefer `StringComparison.Ordinal` or `StringComparison.OrdinalIgnoreCase` for comparisons.

### 10.2 Collections

- Specify initial capacity for `List<T>` and `Dictionary<TKey, TValue>` when size is known.
- Use `IReadOnlyList<T>` and `IReadOnlyDictionary<TKey, TValue>` for return types when mutation is not needed.
- Prefer `Array.Empty<T>()` over `new T[0]`.

### 10.3 LINQ

- Avoid multiple enumeration of `IEnumerable<T>` — materialize with `ToList()` or `ToArray()` when needed.
- Prefer `Any()` over `Count() > 0`.
- Use `Span<T>` and `Memory<T>` for high-performance scenarios.

### 10.4 Memory

- Use `using` statements for `IDisposable` objects.
- Prefer `await using` for `IAsyncDisposable`.
- Be cautious with closures capturing large objects.
- Use `WeakReference<T>` for caches that should not prevent garbage collection.

---

*End of Coding Standards Document*
