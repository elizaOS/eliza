# Find all files matching a filename and return paths with timestamps
# Used by computeruse-workflow-recorder to resolve file paths from window titles
#
# Usage: .\find_file_paths.ps1 -FileName "example.txt"
# Output: JSON array of file candidates with metadata

param(
    [Parameter(Mandatory=$true)]
    [string]$FileName
)

# Default search paths - common user directories
$searchPaths = @(
    "$env:USERPROFILE\Desktop",
    "$env:USERPROFILE\Documents",
    "$env:USERPROFILE\Downloads"
)

# Start timing
$startTime = Get-Date

# Find all matching files
$matches = Get-ChildItem -Path $searchPaths -Filter $FileName -Recurse -ErrorAction SilentlyContinue

# Calculate elapsed time
$elapsed = (Get-Date) - $startTime
$searchTimeMs = [math]::Round($elapsed.TotalMilliseconds, 2)

# Sort by LastAccessTime descending (most recently accessed first)
$sortedMatches = $matches | Sort-Object LastAccessTime -Descending

# Build result object
$result = @{
    filename = $FileName
    search_time_ms = $searchTimeMs
    match_count = $matches.Count
    matches = @($sortedMatches | ForEach-Object {
        @{
            path = $_.FullName
            last_accessed = $_.LastAccessTime.ToString('o')  # ISO 8601 format
            last_modified = $_.LastWriteTime.ToString('o')
            size_bytes = $_.Length
        }
    })
}

# Output as JSON
$result | ConvertTo-Json -Depth 3 -Compress
