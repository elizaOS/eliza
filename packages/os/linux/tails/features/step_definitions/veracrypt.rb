require 'English'
require 'expect'
require 'pty'
require 'tempfile'

$veracrypt_passphrase = 'test'
$veracrypt_hidden_passphrase = 'fdsa'
$veracrypt_volume_name = 'veracrypt'
$veracrypt_pim = '1'
$veracrypt_basic_container_with_pim = "#{MISC_FILES_DIR}/container_with_pim.hc"

def veracrypt_volume_size_in_nautilus(**options)
  if options[:isHidden]
    '52 MB'
  else
    options[:needsPim] ? '147 KB' : '105 MB'
  end
end

def veracrypt_volume_size_in_gnome_disks(**options)
  options[:needsPim] ? '410 KB' : '105 MB'
end

def create_veracrypt_keyfile
  keyfile = Tempfile.create('veracrypt-keyfile', $config['TMPDIR'])
  keyfile << 'asdf'
  keyfile.close
  keyfile.path
end

def reply_prompt(r_f, w_f, prompt_re, answer)
  r_f.expect(prompt_re) do
    debug_log "got prompt, typing #{answer}"
    sleep 1 # tcplay takes some time before it's ready to read our input
    w_f.puts answer.to_s
  end
end

def prepare_veracrypt_volume(type, with_keyfile)
  @veracrypt_is_hidden = (type == 'hidden')
  @veracrypt_needs_keyfile = with_keyfile
  step 'I temporarily create a 100 MiB raw disk named ' \
       "\"#{$veracrypt_volume_name}\""
  disk_path = $vm.storage.disk_path($veracrypt_volume_name)
  keyfile = create_veracrypt_keyfile
  fatal_system "losetup -f '#{disk_path}'"
  loop_dev = `losetup -j '#{disk_path}'`.split(':').first
  create_veracrypt_volume(loop_dev, keyfile)
  map_veracrypt_volume(loop_dev, keyfile)
  populate_veracrypt_volume('veracrypt')
  fatal_system 'tcplay --unmap=veracrypt'
  fatal_system "losetup -d '#{loop_dev}'"
  File.delete(keyfile)
end

def create_veracrypt_volume(block_device, keyfile)
  tcplay_create_cmd = "tcplay --create --device='#{block_device}' " \
                      '--weak-keys --insecure-erase'
  tcplay_create_cmd += ' --hidden' if @veracrypt_is_hidden
  tcplay_create_cmd += " --keyfile='#{keyfile}'" if @veracrypt_needs_keyfile
  debug_log "tcplay create command: #{tcplay_create_cmd}"
  PTY.spawn(tcplay_create_cmd) do |r_f, w_f, pid|
    begin
      w_f.sync = true
      reply_prompt(r_f, w_f, /^Passphrase:\s/, $veracrypt_passphrase)
      reply_prompt(r_f, w_f, /^Repeat passphrase:\s/, $veracrypt_passphrase)
      if @veracrypt_is_hidden
        reply_prompt(r_f, w_f, /^Passphrase for hidden volume:\s/,
                     $veracrypt_hidden_passphrase)
        reply_prompt(r_f, w_f, /^Repeat passphrase:\s/,
                     $veracrypt_hidden_passphrase)
        reply_prompt(r_f, w_f, /^Size of hidden volume.*:\s/, '50M')
      end
      reply_prompt(r_f, w_f, /^\s*Are you sure you want to proceed/, 'y')
      r_f.expect(/^All done!/)
    rescue Errno::EIO
      # Handled by checking $CHILD_STATUS below
    ensure
      Process.wait pid
    end
    $CHILD_STATUS.exitstatus.zero? || raise(
      "#{tcplay_create_cmd} exited with #{$CHILD_STATUS.exitstatus}"
    )
  end
end

def map_veracrypt_volume(block_device, keyfile)
  tcplay_map_cmd = "tcplay --map=veracrypt --device='#{block_device}'"
  tcplay_map_cmd += " --keyfile='#{keyfile}'" if @veracrypt_needs_keyfile
  debug_log "tcplay map command: #{tcplay_map_cmd}"
  PTY.spawn(tcplay_map_cmd) do |r_f, w_f, pid|
    begin
      w_f.sync = true
      reply_prompt(
        r_f, w_f, /^Passphrase:\s/,
        if @veracrypt_is_hidden
          $veracrypt_hidden_passphrase
        else
          $veracrypt_passphrase
        end
      )
      r_f.expect(/^All ok!/)
    rescue Errno::EIO
      # Handled by checking $CHILD_STATUS below
    ensure
      Process.wait pid
    end
    $CHILD_STATUS.exitstatus.zero? || raise(
      "#{tcplay_map_cmd} exited with #{$CHILD_STATUS.exitstatus}"
    )
  end
end

def populate_veracrypt_volume(unlocked_veracrypt_mapping)
  unlocked_block_device = "/dev/mapper/#{unlocked_veracrypt_mapping}"
  fatal_system "mkfs.vfat '#{unlocked_block_device}' >/dev/null"
  Dir.mktmpdir('veracrypt-mountpoint', $config['TMPDIR']) do |mountpoint|
    fatal_system "mount -t vfat '#{unlocked_block_device}' '#{mountpoint}'"
    FileUtils.cp('/usr/share/common-licenses/GPL-3', "#{mountpoint}/GPL-3")
    fatal_system "umount '#{mountpoint}'"
  end
end

When /^I plug a USB drive containing a (.+) VeraCrypt volume( with a keyfile)?$/ do |type, with_keyfile|
  prepare_veracrypt_volume(type, with_keyfile)
  step "I plug USB drive \"#{$veracrypt_volume_name}\""
end

When /^I plug and mount a USB drive containing a (.+) VeraCrypt file container( with a keyfile| with a PIM)?$/ do |type, with_options|
  case with_options
  when ' with a PIM'
    assert_equal('basic', type,
                 'Only basic containers are supported with PIM.')
    @veracrypt_needs_pim = true
    # Instead of creating a container, we use the one we have in Git.
    @veracrypt_shared_dir_in_guest = share_host_files(
      $veracrypt_basic_container_with_pim
    )
    src = "#{@veracrypt_shared_dir_in_guest}/" \
          "#{File.basename($veracrypt_basic_container_with_pim)}"
    dst = "#{@veracrypt_shared_dir_in_guest}/#{$veracrypt_volume_name}"
    $vm.execute_successfully("mv '#{src}' '#{dst}'")
  else
    @veracrypt_needs_pim = false
    prepare_veracrypt_volume(type, with_options)
    @veracrypt_shared_dir_in_guest = share_host_files(
      $vm.storage.disk_path($veracrypt_volume_name)
    )
  end
  $vm.execute_successfully(
    "chown #{LIVE_USER}:#{LIVE_USER} " \
    "'#{@veracrypt_shared_dir_in_guest}/#{$veracrypt_volume_name}'"
  )
end

When /^I unlock and mount this VeraCrypt (volume|file container) with Unlock VeraCrypt Volumes$/ do |support|
  app = launch_unlock_veracrypt_volumes
  case support
  when 'volume'
    app.child('Unlock', roleName: 'button').click
  when 'file container'
    # Clicking on this button breaks accessibility of the app,
    # so we instead use the keyboard
    app.child('Add', roleName: 'button').grabFocus
    @screen.press('Return')

    select_path_in_file_chooser(
      app.child('Choose File Container', roleName: 'file chooser'),
      "#{@veracrypt_shared_dir_in_guest}/#{$veracrypt_volume_name}"
    )
  end
  dialog = gnome_shell_unlock_dialog
  passphrase =
    @veracrypt_is_hidden ? $veracrypt_hidden_passphrase : $veracrypt_passphrase
  assert(dialog.focused_child.roleName == 'password text')
  dialog.focused_child.text = passphrase
  if @veracrypt_needs_pim
    pim_entry = dialog.children(roleName: 'password text').first
    assert(pim_entry.text == '')
    pim_entry.text = $veracrypt_pim
  end
  if @veracrypt_is_hidden
    checkbox = dialog.childLabelled('Hidden Volume')
    checkbox.click
    try_for(10) { checkbox.checked? }
  end
  dialog.button('Unlock').click
  try_for(10) { !gnome_shell_unlock_dialog? }
  try_for(30) do
    !$vm.file_glob('/media/amnesia/*/GPL-3').empty?
  end
end

When /^I unlock and mount this VeraCrypt (volume|file container) with GNOME Disks$/ do |support|
  disks = launch_gnome_disks
  size = veracrypt_volume_size_in_gnome_disks(
    isHidden: @veracrypt_is_hidden,
    needsPim: @veracrypt_needs_pim
  )
  case support
  when 'volume'
    disks.children(roleName: 'table cell')
         .find { |row| /^#{size} Drive/.match(row.name) }
         .grabFocus
  when 'file container'
    disks.child('', description: 'Application Menu').click
    # We can't use the click action here because this button causes a
    # modal dialog to be run via gtk_dialog_run() which causes the
    # application to hang when triggered via a ATSPI action. See
    # https://gitlab.gnome.org/GNOME/gtk/-/issues/1281
    disks.button('Attach Disk Image… (.iso, .img)').grabFocus
    @screen.press('Return')

    attach_dialog = disks.child('Select Disk Image to Attach',
                                roleName: 'file chooser')
    attach_dialog.child('Set up read-only loop device',
                        roleName: 'check box').click
    filter = attach_dialog.child('Disk Images (*.img, *.iso)',
                                 roleName: 'combo box')
    filter.press
    try_for(5) do
      filter.child('All Files', roleName: 'menu item').click
      true
    rescue Dogtail::Failure
      # we probably clicked too early, which triggered an "Attempting
      # to generate a mouse event at negative coordinates" Dogtail error
      false
    end

    # Make the file chooser show the location text entry
    attach_dialog.child('File Chooser Widget', roleName: 'file chooser')
                 .doActionNamed('show_location')
    # Enter the location
    text_entry = attach_dialog.child('Location Layer').child(roleName: 'text')
    text_entry.text = "#{@veracrypt_shared_dir_in_guest}/#{$veracrypt_volume_name}"
    # For some reason two activate calls are necessary to close the dialog
    text_entry.activate
    text_entry.activate

    step 'I cancel the GNOME authentication prompt'
    try_for(15) do
      disks.children(roleName: 'table cell')
           .find { |row| /^#{size} Loop Device/.match(row.name) }
           .grabFocus
      true
    rescue NoMethodError
      false
    end
  end
  disks.child(
    roleName:    'button',
    description: 'Unlock selected encrypted partition'
  ).click
  unlock_dialog = disks.dialog('Set options to unlock')
  unlock_dialog.child('', roleName: 'password text').text =
    @veracrypt_is_hidden ? $veracrypt_hidden_passphrase : $veracrypt_passphrase
  if @veracrypt_needs_pim
    unlock_dialog.childLabelled('PIM').text = $veracrypt_pim
  end
  if @veracrypt_needs_keyfile
    $vm.file_overwrite('/tmp/keyfile', 'asdf')
    # Focus the keyfiles combo box using the workaround for #15952
    # that we implemented upstream
    @screen.press('alt', 'k')
    @screen.press('Return')
    select_path_in_file_chooser(
      disks.child('Select a Keyfile', roleName: 'file chooser'),
      '/tmp/keyfile'
    )
  end
  if @veracrypt_is_hidden
    check_box = unlock_dialog.child('Hidden', roleName: 'check box')
    check_box.click
    try_for(10) { check_box.checked? }
  end
  unlock_dialog.button('Unlock').click
  try_for(30, msg: 'Failed to mount the unlocked volume') do
    outer = disks.child("#{size} VeraCrypt/TrueCrypt",
                        roleName: 'panel')
    outer.grabFocus
    # Move the focus down to the "Filesystem\n#{size} FAT" item (that Dogtail
    # is not able to find) using the 'Down' arrow, in order to display
    # the "Mount selected partition" button.
    @screen.press('down')
    try_for(10) do
      disks.children(roleName: 'panel')
           .find { |c| /Filesystem\n\d+ [KM]B FAT/.match(c.name) }
           .focused?
    end
    disks.child(
      '',
      description: 'Mount selected partition',
      roleName:    'button'
    ).click
    true
  rescue Dogtail::Failure
    # we probably did something too early, which triggered a Dogtail error
    # such as "Attempting to generate a mouse event at negative coordinates"
    false
  end
  try_for(10, msg: '/media/amnesia/*/GPL-3 does not exist') do
    !$vm.file_glob('/media/amnesia/*/GPL-3').empty?
  end
end

def nautilus_with_open_veracrypt_volume
  volume_size_in_nautilus = veracrypt_volume_size_in_nautilus(
    isHidden: @veracrypt_is_hidden,
    needsPim: @veracrypt_needs_pim
  )
  Dogtail::Application.new('org.gnome.Nautilus').window(
    "#{volume_size_in_nautilus} Volume"
  )
end

When /^I open this VeraCrypt volume in GNOME Files$/ do
  $vm.spawn('nautilus /media/amnesia/*', user: LIVE_USER)
  nautilus_with_open_veracrypt_volume
end

Then /^I see the expected contents in this VeraCrypt volume$/ do
  nautilus_with_open_veracrypt_volume.child('GPL-3',
                                            roleName: 'table cell')
end

When /^I lock the currently opened VeraCrypt (volume|file container)$/ do |support|
  action = if support == 'file container'
             'Unmount'
           else
             'Eject'
           end
  nautilus_with_open_veracrypt_volume.button(action).click
end

Then /^the VeraCrypt (?:volume|file container) has been unmounted and locked$/ do
  assert_empty($vm.file_glob('/media/amnesia/*/GPL-3'))
  assert_empty($vm.file_glob('/dev/mapper/tcrypt-*'))
end
