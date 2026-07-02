
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$savePath = 'C:\Users\Administrator\.codex\worktrees\35d8\eliza\.github\issue-evidence\9581-windows-cua\input-recording\windows-cua-input-target.txt'
$form = New-Object System.Windows.Forms.Form
$form.Text = 'elizaOS CUA Input Target 8612'
$form.Width = 920
$form.Height = 680
$form.StartPosition = 'CenterScreen'
$form.KeyPreview = $true
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.AcceptsReturn = $true
$box.AcceptsTab = $true
$box.ScrollBars = 'Both'
$box.WordWrap = $false
$box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Consolas', 16)
$form.Controls.Add($box)
$save = {
  [System.IO.File]::WriteAllText($savePath, $box.Text)
  $form.Text = 'elizaOS CUA Input Target 8612 (saved)'
}
$box.Add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::S) {
    & $save
    $_.SuppressKeyPress = $true
  }
})
$form.Add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::S) {
    & $save
    $_.SuppressKeyPress = $true
  }
})
$form.Add_Shown({ $box.Focus() })
[void]$form.ShowDialog()
