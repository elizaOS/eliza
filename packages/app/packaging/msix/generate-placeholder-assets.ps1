# generate-placeholder-assets.ps1 — Generate placeholder MSIX visual assets.
# Run manually once, then replace with final artwork before Store submission.
#
# Usage: pwsh -File generate-placeholder-assets.ps1

param(
  [string]$OutputDir = (Join-Path $PSScriptRoot "assets")
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Add-Type -AssemblyName System.Drawing

$sizes = @{
  "StoreLogo.png" = @(50, 50)
  "Square44x44Logo.png" = @(44, 44)
  "Square150x150Logo.png" = @(150, 150)
  "Wide310x150Logo.png" = @(310, 150)
  "LargeTile.png" = @(310, 310)
}

foreach ($entry in $sizes.GetEnumerator()) {
  $width = $entry.Value[0]
  $height = $entry.Value[1]
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 26, 26, 46))

  $fontSize = [math]::Min($width, $height) * 0.4
  $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, 0, $width, $height)
  $graphics.DrawString("M", $font, $brush, $rect, $sf)

  $outputPath = Join-Path $OutputDir $entry.Key
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()

  Write-Host "Created: $($entry.Key) (${width}x${height})"
}

Write-Host "Placeholder assets generated in $OutputDir"
Write-Host "Replace these with final artwork before Store submission."
