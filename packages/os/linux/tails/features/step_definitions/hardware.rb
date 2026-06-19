Given /^the computer has an unsupported graphics card$/ do
  @boot_options = 'autotest_broken_gnome_shell'
end

When /^Tails detects disk read failures on the (.+)$/ do |device|
  disk_ioerrors = '/var/lib/live/tails.disk.ioerrors'
  fake_ioerror_script_path = '/tmp/fake_ioerror.py'

  case device
  when 'SquashFS'
    fake_error = 'SQUASHFS error: A fake error.'
  when 'boot device'
    b_d = boot_device.delete_prefix('/dev/').delete_suffix('1')
    fake_error = "I/O error, dev #{b_d}, sector - a fake boot device one."
  when 'boot device with a target error'
    b_d = boot_device.delete_prefix('/dev/').delete_suffix('1')
    fake_error = "critical target error, dev #{b_d}, sector - a fake boot device one."
  end

  fake_ioerror_script = <<~FAKEIOERROR
    from systemd import journal
    journal.send("#{fake_error}", SYSLOG_IDENTIFIER="kernel", PRIORITY=3)
  FAKEIOERROR
  $vm.file_overwrite(fake_ioerror_script_path, fake_ioerror_script)
  $vm.execute_successfully(
    'systemctl --quiet is-active tails-detect-disk-ioerrors'
  )
  $vm.execute_successfully("python3 #{fake_ioerror_script_path}")
  try_for(60) { $vm.file_exist?(disk_ioerrors) }
end

Given /^(.+) is damaged in a way that some read operations fail$/ do |device|
  add_early_boot_hook do
    step "Tails detects disk read failures on the #{device}"
  end
end

Then /^I see a disk failure message$/ do
  @screen.wait_text('Error Reading Data from Tails USB Stick', 10)
end

Then /^I see a disk failure message on the splash screen$/ do
  @screen.wait_text('Error reading data from your Tails USB stick.', 60)
end

Then /^I can open the hardware failure documentation from the disk failure message$/ do
  click_gnome_shell_notification_button('Learn More')
  try_for(60) { @torbrowser = Dogtail::Application.new('Firefox') }
  step '"Tails - Error Reading Data from Tails USB Stick" has loaded in the Tor Browser'
end

Then /^I see a graphics card failure message on the splash screen$/ do
  @screen.wait('PlymouthGraphicsCardFailureMessage.png', 60)
end

When /^I corrupt the boot device's GPT backup (header|partition table)$/ do |thing|
  # Code borrowed from the "test_gpt_corruption" case in the
  # first_boot_repartition script.
  parent_device = boot_device.sub(/[0-9]+$/, '')
  sectors = $vm.execute_successfully("blockdev --getsz '#{parent_device}'").stdout.to_i
  if thing == 'header'
    $vm.execute_successfully(
      "dd if=/dev/zero of='#{parent_device}' bs=512 count=1 seek=#{sectors - 1} " \
      'oflag=direct'
    )
  else
    $vm.execute_successfully(
      "dd if=/dev/zero of='#{parent_device}' bs=512 count=32 seek=#{sectors - 33} " \
      'oflag=direct'
    )
  end
end

Then /^the Greeter recommends reinstalling Tails due to partitioning errors$/ do
  greeter.child(
    'Errors were detected in the partitioning of your Tails USB stick.\n\n' \
    'Try reinstalling Tails. If the error persists, reinstall on a new USB stick.',
    roleName: 'label'
  )
end

Then /^I am recommended to migrate to a new USB stick due to partitioning errors$/ do
  warning = Dogtail::Application.new('zenity').dialog('Partitioning Error')
  assert_not_nil(
    warning.children(roleName: 'label')[1]
           .text['We recommend that you create a backup of your Tails']
  )
end

Then /^I am recommended to reinstall Tails due to partitioning errors$/ do
  warning = Dogtail::Application.new('zenity').dialog('Partitioning Error')
  text = warning.children(roleName: 'label')[1].text
  assert_include(text, 'Creation of Persistent Storage has been disabled')
  assert_include(text, 'We recommend that you reinstall Tails')
end

Then /^the Greeter forbids creating a persistent partition$/ do
  assert_false(
    greeter.child('Create Persistent Storage', roleName: 'toggle button').sensitive?
  )
end

Then /^the Greeter forbids starting Tails$/ do
  assert_false(
    greeter.child('Start Tails', roleName: 'button').sensitive?
  )
end

Then /^the Greeter forbids all settings but language$/ do
  assert(
    greeter.child('Language', roleName: 'label').sensitive?
  )
  assert_false(
    greeter.child('Keyboard Layout', roleName: 'label').sensitive?
  )
  assert_false(
    greeter.child('Formats', roleName: 'label').sensitive?
  )
  assert_false(
    greeter.child('Additional Settings', roleName: 'label').sensitive?
  )
end

Then /^I am told that Persistent Storage cannot be created$/ do
  launch_persistent_storage(check_started: false)
  step 'I am recommended to reinstall Tails due to partitioning errors'
end

Then /^Tails detected partitioning error (.*)$/ do |expected_reason|
  actual_reason = $vm.file_content(
    '/var/lib/live/config/tails.disk-partitioning-errors'
  ).chomp
  assert_equal(expected_reason, actual_reason)
end

Given /^I simulate a computer with (old|new) UEFI CA$/ do |ca|
  old = "3590bfd89 Microsoft Corporation KEK CA 2011\n"
  new = "xxxxxxxxx Microsoft Corporation KEK 2K CA 2023\n"
  content = if ca == 'old'
              old
            else
              old + new
            end
  $vm.file_overwrite('/etc/fake-mokutil.conf', content)
  $vm.file_overwrite('/usr/bin/mokutil', [
                       '#!/bin/sh',
                       'until test -f /tails-uefi-ca-notify-run; do sleep 1; done',
                       'cat /etc/fake-mokutil.conf',
                     ])
end

Given /^I unblock tails-uefi-ca-notify$/ do
  # Since the main "output" of tails-uefi-ca-notify is to show a notification,
  # and in the automated test suite we're competing with multiple notifications,
  # we make the script "hang" until this file is created, which we'll only do after we
  # cleared previous notifications.
  $vm.execute('touch /tails-uefi-ca-notify-run')
end
