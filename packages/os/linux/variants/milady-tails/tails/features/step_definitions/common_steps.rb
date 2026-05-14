require 'fileutils'
require 'tempfile'
require 'open3'

def post_vm_start_hook
  $vm.late_patch if $config['LATE_PATCH']

  # Sometimes the first click is lost (presumably it's used to give
  # focus to virt-viewer or similar) so we do that now rather than
  # having an important click lost. The point we click should be
  # somewhere where no clickable elements generally reside.
  @screen.click(@screen.w - 1, @screen.h / 2)
end

def gnome_activities_overview_image
  case $language
  when 'Arabic', 'Persian'
    'GnomeApplicationsMenuRTL.png'
  else
    'GnomeApplicationsMenu.png'
  end
end

def post_snapshot_restore_hook(snapshot_name, num_try)
  # Press escape to wake up the display
  @screen.press('Escape')

  $vm.wait_until_remote_shell_is_up

  pattern = if snapshot_name.end_with?('tails-greeter')
              'TailsGreeter.png'
            else
              gnome_activities_overview_image
            end

  begin
    try_for(10, delay: 0) do
      @screen.find(pattern)
      # Sometimes the display becomes inactive 1 to 2 seconds after the
      # snapshot was restored. To catch those cases, we wait a short time
      # and make sure that we can still find the pattern.
      # We don't want this to be longer than necessary, because this will
      # slow down all tests which restore snapshots.
      sleep 3
      @screen.find(pattern)
    rescue FindFailed
      # Press escape to wake up the display
      @screen.press('Escape')
      next
    end
  rescue Timeout::Error
    if num_try == 3
      raise 'Failed to restore snapshot'
    end

    scenario_indent = ' ' * 4
    debug_log("#{scenario_indent}Failed to restore snapshot, retrying...",
              color: :yellow, timestamp: false)
    reach_checkpoint(snapshot_name, num_try + 1)
    return
  end

  post_vm_start_hook

  # Increase the chances that by the time we leave this function, if
  # the click in post_vm_start_hook() has opened the Applications menu
  # (which sometimes happens, go figure), that menu is closed and the
  # desktop is back to its normal state. Otherwise, all kinds of
  # trouble may arise: for example, pressing SUPER to open the
  # Activities Overview would fail (SUPER has no effect when the
  # Applications menu is still opened).
  @screen.press('Escape')
  # Wait for the menu to be closed
  sleep 1

  # The guest's Tor circuits are likely to get out of sync
  # with our Chutney network, so we ensure that we have fresh circuits.
  # Time jumps and incorrect clocks also confuse Tor in many ways.
  already_synced_time_host_to_guest = false
  # tor@default.service is always active, so we need to check if Tor
  # was configured in the snapshot we are using: for example,
  # with-network-logged-in-unsafe-browser connects to the LAN
  # but did not configure Tor.
  if $vm.connected_to_network? &&
     $vm.execute('systemctl --quiet is-active tor@default.service').success? &&
     check_disable_network != '1'
    debug_log('Restarting Tor...')
    $vm.execute('systemctl stop tor@default.service')
    $vm.host_to_guest_time_sync
    already_synced_time_host_to_guest = true
    wait_until_chutney_is_working unless @real_tor
    $vm.execute('systemctl start tor@default.service')
    wait_until_tor_is_working
  end
  $vm.host_to_guest_time_sync unless already_synced_time_host_to_guest
end

Given /^a computer$/ do
  $vm&.destroy_and_undefine
  $vm = VM.new($virt, VM_XML_PATH, $vmnet, $vmstorage, DISPLAY)
end

Given /^the computer is set to boot from the Tails DVD$/ do
  $vm.set_cdrom_boot(TAILS_ISO)
end

Given /^the computer is set to boot from (.+?) drive "(.+?)"$/ do |type, name|
  $vm.set_disk_boot(name, type.downcase)
end

Given /^I (temporarily )?create an? (\d+) ([[:alpha:]]+) (?:([[:alpha:]]+) )?disk named "([^"]+)"$/ do |temporary, size, unit, type, name|
  type ||= 'qcow2'
  begin
    $vm.storage.create_new_disk(name, size:, unit:, type:)
  rescue NoSpaceLeftError => e
    cmd = "du -ah \"#{$config['TMPDIR']}\" | sort -hr | head -n20"
    info_log("#{cmd}\n" + `#{cmd}`)
    raise e
  end
  add_after_scenario_hook { $vm.storage.delete_volume(name) } if temporary
end

Given /^I plug (.+) drive "([^"]+)"$/ do |bus, name|
  $vm.plug_drive(name, bus.downcase)
  sleep 1
  step "drive \"#{name}\" is detected by Tails" if $vm.running?
end

Then /^drive "([^"]+)" is detected by Tails$/ do |name|
  raise 'Tails is not running' unless $vm.running?

  try_for(20, msg: "Drive '#{name}' is not detected by Tails") do
    $vm.disk_detected?(name)
  end
end

Given /^the network is plugged$/ do
  unless @real_tor
    wait_until_chutney_is_working
    begin
      finalize_simulated_Tor_network_configuration
    rescue Errno::ENOENT => e
      raise e if $vm.running?

      raise 'This step must be run after the remote shell is up'
    end
  end
  $vm.plug_network
end

Given /^the network is unplugged$/ do
  $vm.unplug_network
end

Given /^I (connect|disconnect) the network through GNOME$/ do |action|
  toggle_gnome_system_menu
  Dogtail::Application.new('gnome-shell')
                      .child('Wired', roleName: 'label')
                      .parent.parent.parent.parent
                      .child('Open menu', roleName: 'button')
                      .click
  Dogtail::Application.new('gnome-shell')
                      .child(action.capitalize, roleName: 'label')
                      .click
  toggle_gnome_system_menu
end

Given /^the network connection is ready(?: within (\d+) seconds)?$/ do |timeout|
  timeout ||= 30
  try_for(timeout.to_i) { $vm.connected_to_network? }
end

Given /^the hardware clock is set to "([^"]*)"$/ do |time|
  dt = if time.start_with?('+') || time.start_with?('-')
         DateTime.parse(
           cmd_helper(['date', '-d', time], env: { 'TZ' => 'UTC' })
         )
       else
         DateTime.parse(time)
       end
  debug_log("Set hw clock to #{dt}")
  $vm.set_hardware_clock(dt.to_time)
end

Given /^I capture all network traffic$/ do
  @sniffer = Sniffer.new('sniffer', $vmnet)
  @sniffer.capture
  add_after_scenario_hook do
    @sniffer.stop
    @sniffer.clear
  end
end

Given /^I set Tails to boot with options "([^"]*)"$/ do |options|
  @boot_options = options
end

Given /^I set Tails to run with real Tor network$/ do
  @real_tor = true
end

When /^I start the computer$/ do
  assert(!$vm.running?,
         'Trying to start a VM that is already running')
  $vm.start
  JournalDumper.instance.start
  $language = ''
  $lang_code = ''
end

Given /^I start Tails( from DVD)?( with network unplugged)?( and I login)?$/ do |dvd_boot, network_unplugged, do_login|
  step 'the computer is set to boot from the Tails DVD' if dvd_boot
  step 'I start the computer'
  step 'the computer boots Tails'
  if network_unplugged
    step 'the network is unplugged'
  else
    step 'the network is plugged'
  end
  if do_login
    step 'I log in to a new session'
    if network_unplugged
      step 'all notifications have disappeared'
    else
      step 'Tor is ready'
      step 'all notifications have disappeared'
      step 'available upgrades have been checked'
    end
  end
end

Given /^I start Tails from (.+?) drive "(.+?)"( with network unplugged)?( and I login( with persistence enabled)?( with the changed persistence passphrase)?( (?:and|with) an administration password)?)?$/ do |drive_type, drive_name, network_unplugged, do_login, persistence_on, persistence_with_changed_passphrase, admin_password| # rubocop:disable Metrics/ParameterLists
  step "the computer is set to boot from #{drive_type} drive \"#{drive_name}\""
  step 'I start the computer'
  step 'the computer boots Tails'
  if network_unplugged
    step 'the network is unplugged'
  else
    step 'the network is plugged'
  end
  if do_login
    step 'I enable persistence' if persistence_on
    step 'I enable persistence with the changed passphrase' \
      if persistence_with_changed_passphrase
    @additional_software_expected_to_start =
      $vm.file_exist?(ASP_CONF) && !$vm.file_empty?(ASP_CONF)
    step 'I set an administration password' if admin_password
    step 'I log in to a new session'
    step 'the Additional Software installation service has started' \
      if @additional_software_expected_to_start
    if network_unplugged
      step 'all notifications have disappeared'
    else
      step 'Tor is ready'
      step 'all notifications have disappeared'
      step 'available upgrades have been checked'
    end
  end
end

Given /^I start Tails from a freshly installed USB drive with an administration password and the network is plugged and I login$/ do
  step 'I have started Tails without network from a USB drive ' \
       'without a persistent partition ' \
       "and stopped at Tails Greeter's login screen"
  step 'I set an administration password'
  step 'I log in to a new session'
  step 'the network is plugged'
  step 'Tor is ready'
  step 'all notifications have disappeared'
  step 'available upgrades have been checked'
end

When /^I power off the computer$/ do
  assert($vm.running?,
         'Trying to power off an already powered off VM')
  $vm.power_off
end

When /^I cold reboot the computer$/ do
  step 'I shutdown Tails and wait for the computer to power off'
  step 'I start the computer'
end

def boot_menu_cmdline_images
  case @os_loader
  when 'UEFI'
    ['TailsBootMenuKernelCmdlineUEFI_Bookworm.png']
  else
    ['TailsBootMenuKernelCmdline.png', 'TailsBootMenuKernelCmdline_alt.png']
  end
end

def boot_menu_images
  case @os_loader
  when 'UEFI'
    ['TailsBootMenuGRUB_Bookworm.png']
  else
    ['TailsBootMenuSyslinux.png', 'TailsBootMenuSyslinux_alt.png']
  end
end

def up_spammer_code(domain_name)
  <<-SCRIPT
    require 'libvirt'
    up_key_code = 0x67
    virt = Libvirt::open("qemu:///system")
    begin
      domain = virt.lookup_domain_by_name('#{domain_name}')
      loop do
        domain.send_key(Libvirt::Domain::KEYCODE_SET_LINUX, 0, [up_key_code])
        sleep 1
      end
    ensure
      virt.close
    end
  SCRIPT
end

def start_up_spammer(domain_name)
  up_spammer_unit_name = 'tails-test-suite-up-spammer.service'
  bus = ENV['USER'] == 'root' ? '--system' : '--user'
  systemctl = ['/bin/systemctl', bus]
  kill_up_spammer = proc do
    if system(*systemctl, '--quiet', 'is-active', up_spammer_unit_name)
      system(*systemctl, 'stop', up_spammer_unit_name)
    end
  rescue StandardError
    # noop
  end
  kill_up_spammer.call
  up_spammer_job = fatal_system(
    '/usr/bin/systemd-run',
    bus,
    "--unit=#{up_spammer_unit_name}",
    '--quiet',
    '--collect',
    '/usr/bin/ruby',
    '-e', up_spammer_code(domain_name)
  )
  add_after_scenario_hook { kill_up_spammer.call }
  [up_spammer_job, kill_up_spammer]
end

def enter_boot_menu_cmdline
  boot_timeout = 3 * 60
  # Simply looking for the boot splash image is not robust; sometimes
  # our image matching is not fast enough to see it. Here we hope that spamming
  # UP, which will halt the boot process, will make this a bit more robust.
  # The below code is not completely reliable, so we might have to
  # retry by rebooting.
  try_for(boot_timeout) do
    begin
      _up_spammer_job, kill_up_spammer = start_up_spammer($vm.domain_name)
      @screen.wait_any(boot_menu_images, 15)
      kill_up_spammer.call

      # Navigate to the end of the kernel command-line
      case @os_loader
      when 'UEFI'
        @screen.type('e')
        3.times { @screen.press('Down') }
        @screen.press('End')
      else
        @screen.press('Tab')
      end
      @screen.wait_any(boot_menu_cmdline_images, 5)
    rescue FindFailed => e
      debug_log('We missed the boot menu before we could deal with it, ' \
                'resetting...')
      @has_been_reset = true
      $vm.reset
      raise e
    ensure
      kill_up_spammer.call
    end
    true
  end
end

# These hooks are executed as soon as the remote shell is up, and will
# block the boot process; in particular, these hooks are executed
# before the Welcome Screen is started.
def add_early_boot_hook(&block)
  @early_boot_hooks ||= []
  @early_boot_hooks << block
end

def wait_for_ponytail(user: LIVE_USER, timeout: 60)
  try_for(timeout) do
    $vm.execute(
      'dbus-send --session --print-reply ' \
      '--dest=org.gnome.Shell.Introspect ' \
      '/org/gnome/Shell/Introspect ' \
      'org.gnome.Shell.Introspect.GetWindows',
      user:
    ).success?
  end
rescue Timeout::Error
  raise 'Known issue #21211: timed out while waiting for the GNOME Shell Introspect API'
end

Given /^the computer (?:re)?boots Tails$/ do
  enter_boot_menu_cmdline
  boot_key = @os_loader == 'UEFI' ? 'F10' : 'Return'
  early_patch = config_bool('EARLY_PATCH') ? ' early_patch=umount' : ''
  extra_boot_options = $config['EXTRA_BOOT_OPTIONS'] || ''
  @screen.type(' autotest_never_use_this_option ' \
               ' blacklist=psmouse' \
               " #{early_patch} #{@boot_options} #{extra_boot_options}",
               [boot_key])
  $vm.wait_until_remote_shell_is_up(5 * 60)

  post_vm_start_hook
  configure_simulated_Tor_network unless @real_tor

  # Disable GTK4 shadows, required for Dogtail to accurately locate
  # positions of elements in GTK4 applications.
  [
    [LIVE_USER, "/home/#{LIVE_USER}"],
    ['Debian-gdm', '/var/lib/gdm3'],
  ].each do |user, home_dir|
    $vm.execute_successfully("mkdir -p '#{home_dir}/.config/gtk-4.0'")
    $vm.file_overwrite(
      "#{home_dir}/.config/gtk-4.0/gtk.css",
      'window, .popover, .tooltip { box-shadow: none; }'
    )
    $vm.execute_successfully(
      "chown #{user}:#{user} '#{home_dir}/.config'"
    )
    $vm.execute_successfully(
      "chown -R #{user}:#{user} '#{home_dir}/.config/gtk-4.0'"
    )
  end

  @early_boot_hooks&.each(&:call)
  RemoteShell::SignalReady.new($vm)

  unless @scenario.match_tags?('@broken_welcome_screen')
    # There is a window of time while the Welcome Screen is
    # initializing when attempting to use Dogtail breaks it for the
    # rest of the session. That window is closed once the Welcome
    # Screen appears, so we wait for that to happen using image
    # matching.
    found = @screen.wait_any(
      ['TailsGreeter.png', 'PlymouthGraphicsCardFailureMessage.png'], 60
    )
    if found.image == 'PlymouthGraphicsCardFailureMessage.png'
      raise 'Known issue #20282: Error starting GDM with your graphics card'
    end

    # Enable GNOME introspection for Dogtail and Ponytail
    $vm.execute_successfully('gnome-extensions enable automated-testing@tails.net',
                             user: 'Debian-gdm')
    wait_for_ponytail(user: 'Debian-gdm')
    # Close the notification which otherwise obscures parts of the
    # Welcome Screen window.
    close_notification('System was put in unsafe mode')
  end
end

def close_notification(msg)
  Dogtail::Application.new('gnome-shell', user: 'Debian-gdm')
                      .child(roleName: 'notification')
                      .child(msg, roleName: 'label')
                      .click
end

Given /^I set the formats to "(.*)"$/ do |region|
  try_for(30) do
    greeter.child(description: 'Configure Formats').grabFocus
    @screen.press('Return')
    # Give Gtk some time to open the popover
    sleep(1)
    # Check if the popover is open
    greeter.child?('Search', roleName: 'text', retry: false)
  end
  greeter.child('Search', roleName: 'text').text = region
  sleep(2) # Gtk needs some time to filter the results
  greeter.child('Search', roleName: 'text').activate
end

Given /^I set the language to (.*) \((.*)\)$/ do |lang, lang_code|
  $language = lang
  $lang_code = lang_code
  # The listboxrow does not expose any actions through AT-SPI,
  # so Dogtail is unable to click it directly. We let it grab focus
  # and activate it via the keyboard instead.
  try_for(30) do
    greeter.child(description: 'Configure Language').grabFocus
    @screen.press('Return')
    # Give Gtk some time to open the language popover
    sleep(1)
    # Check if the language popover is open
    greeter.child?('Search', roleName: 'text', retry: false)
  end
  greeter.child('Search', roleName: 'text').text = lang
  sleep(2) # Gtk needs some time to filter the results
  greeter.child('Search', roleName: 'text').activate
end

When /^I save the language and keyboard options in cleartext storage$/ do
  greeter
    .child('Save', roleName: 'label')
    .parent
    .child(roleName: 'toggle button')
    .toggle

  greeter
    .child('Question', roleName: 'alert')
    .child('Save Unencrypted', roleName: 'button')
    .click
end

Given /^I log in to a new session(?: in ([^ ]*) \(([^ ]*)\))?( without activating the Persistent Storage)?( after having activated the Persistent Storage| expecting no warning about the Persistent Storage not being activated)?$/ do |lang, lang_code, expect_warning, expect_no_warning|
  # We find the login button before localizing it since it's easier to
  # find then.
  login_button = greeter.child('_Start Tails', roleName: 'button')
  if lang && lang != 'English'
    step "I set the language to #{lang} (#{lang_code})"
    # After selecting options (language, administration password,
    # etc.), the Greeter needs some time to focus the main window
    # back, so that typing the accelerator for the "Start Tails"
    # button is honored.
    sleep(10)
  end
  login_button.click

  begin
    @screen.wait('PersistentStorageNotUnlocked.png', 4)
    assert(!expect_no_warning)
    saw_warning = true
    @screen.press('Right')
    @screen.press('Return')
  rescue FindFailed
    saw_warning = false
  end

  if expect_warning
    assert(saw_warning)
  end

  step 'the Tails desktop is ready'
end

def open_greeter_additional_settings
  # For some reason, using the action 'click' makes the whole Welcome
  # Screen become invisible to Dogtail, so we call the tree click
  # method directly, which doesn't have this problem.
  greeter.child('Add an additional setting', roleName: 'button')
         .click(force_tree_api: true)

  greeter.child('Additional Settings', roleName: 'dialog')
end

Given /^I open Tails Greeter additional settings dialog$/ do
  open_greeter_additional_settings
end

def wait_for_welcome_screen_settings_to_vanish
  try_for(10) do
    assert_raise(Dogtail::Failure) do
      greeter.child('Additional Settings', roleName: 'dialog', retry: false)
    end
    true
  end
end

Given /^I disable networking in Tails Greeter$/ do
  dialog = open_greeter_additional_settings
  dialog.child('Offline Mode', roleName: 'label').click
  dialog.child('Disable all networking').click
  dialog.child('Add', roleName: 'button').click
  wait_for_welcome_screen_settings_to_vanish
end

Given /^I set an administration password$/ do
  dialog = open_greeter_additional_settings
  dialog.child('Administration Password', roleName: 'label').click
  dialog.childLabelled('Administration Password').text = @sudo_password
  dialog.childLabelled('Confirm').text = @sudo_password
  dialog.child('Add', roleName: 'button').click
  wait_for_welcome_screen_settings_to_vanish
end

Given /^I disable the Unsafe Browser$/ do
  dialog = open_greeter_additional_settings
  dialog.child('Unsafe Browser', roleName: 'label').click
  dialog.child('Disable the Unsafe Browser').click
  dialog.child('Add', roleName: 'button').click
  wait_for_welcome_screen_settings_to_vanish
end

Given /^the Tails desktop is ready$/ do
  # GNOME normally starts with the Activities Overview open, but we
  # enable the no-overview@fthx extension to exit to the normal
  # desktop. Since Trixie the extension sometimes fails to exit the
  # Activities Overview, and we detect that here by increasing the
  # sensitivity so it only matches the Activities Overview button when
  # it is unpressed and not showing the Activities Overview (with the
  # default sensitivity it matches both states).
  @screen.wait(gnome_activities_overview_image, 180, sensitivity: 0.95)
  # Disable screen blanking since we sometimes need to wait long
  # enough for it to activate, which can cause problems when we are
  # waiting for an image for a very long time.
  $vm.execute_successfully(
    'gsettings set org.gnome.desktop.session idle-delay 0',
    user: LIVE_USER
  )
  # We need to enable the accessibility toolkit for dogtail.
  $vm.execute_successfully(
    'gsettings set org.gnome.desktop.interface toolkit-accessibility true',
    user: LIVE_USER
  )
  # And also for the root user for applications that run with
  # sudo/pkexec under XWayland.
  $vm.execute_successfully(
    'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus ' \
    'gsettings set org.gnome.desktop.interface toolkit-accessibility true'
  )
  # Optimize upgrade check: avoid 30 second sleep
  $vm.execute_successfully(
    'sed -i "s/^ExecStart=.*$/& --no-wait/" ' \
    '/usr/lib/systemd/user/tails-upgrade-frontend.service'
  )
  $vm.execute_successfully('systemctl --user daemon-reload', user: LIVE_USER)
  wait_for_ponytail
end

When /^I (don't )?see the "(.+)" notification(?: after at most (\d+) seconds)?$/ do |negate, title, timeout|
  if negate
    assert_raise(Timeout::Error) do
      wait_notification(title, timeout)
    end
  else
    wait_notification(title, timeout)
  end
end

def wait_notification(title, timeout)
  timeout = timeout ? timeout.to_i : nil
  gnome_shell = Dogtail::Application.new('gnome-shell')
  notification_list = gnome_shell.child(
    'No Notifications', roleName: 'label', showingOnly: false
  ).parent.parent
  try_for(timeout) do
    notification_list.child?(title, roleName: 'label', showingOnly: false)
  end
end

Given /^Tor is ready$/ do
  # deprecated: please choose between "I successfully configure Tor"
  # and "I wait until Tor is ready"
  step 'I successfully configure Tor'
end

##
# this is a #18293-aware version of `tor_variable get --type=conf DisableNetwork`
def check_disable_network
  disable_network = nil
  # Gather debugging information for #18557
  try_for(10) do
    disable_network = $vm.execute_successfully(
      '/usr/local/lib/tor_variable get --type=conf DisableNetwork'
    ).stdout.chomp
    if disable_network == ''
      debug_log('Tor claims DisableNetwork is an empty string')
      false
    else
      true
    end
  end
  disable_network
end

Given /^I successfully configure Tor$/ do
  # First we wait for tor's control port to be ready...
  try_for(60) do
    $vm.execute_successfully('/usr/local/lib/tor_variable get --type=info version')
    true
  end
  # ... so we can ask if the tor's networking is disabled, in which
  # case Tor Connection Assistant has not been dealt with yet. If
  # tor's networking is enabled at this stage it means we already ran
  # some steps dealing with Tor Connection Assistant, presumably to
  # configure bridges.  Otherwise we just treat this as the default
  # case, where it is not important for the test scenario that we go
  # through the extra hassle and use bridges, so we simply attempt a
  # direct connection.
  disable_network = check_disable_network
  if disable_network == '1'
    # This variable is initialized to false in each scenario, and only
    # ever set to true in some previously run step that configures tor
    # to explicitly use PTs; please note that when it is false, it still
    # means that Tor _might_ be using bridges
    debug_log('DisableNetwork=1, so we autoconnect')
    assert(!@user_wants_pluggable_transports, 'This is a test suite bug!')
    @user_wants_pluggable_transports = false
    step 'the Tor Connection Assistant autostarts'
    step 'I configure a direct connection in the Tor Connection Assistant'
  end

  step 'I wait until Tor is ready'
end

Then /^I wait( for a long time)? until Tor is ready$/ do |long_wait|
  wait_opts = {}
  wait_opts[:timeout] = 60 * 10 if long_wait
  wait_until_tor_is_working(**wait_opts)
  step 'the time has synced'
  debug_log('user_wants_pluggable_transports = ' \
           "#{@user_wants_pluggable_transports} " \
           'tor_network_is_blocked = ' \
           "#{@tor_network_is_blocked}")
  must_use_pluggable_transports = \
    if !@user_wants_pluggable_transports
      # In this case, tca is allowing both methods,
      # and will use PTs depending on network conditions
      defined?(@tor_network_is_blocked) && @tor_network_is_blocked
    else
      true
    end
  if must_use_pluggable_transports
    step 'Tor is not confined with Seccomp'
  else
    step 'Tor is confined with Seccomp'
  end
  @tor_success_configs ||= []
  @tor_success_configs << $vm.execute_successfully(
    '/usr/local/lib/tor_variable get --type=info config-text', libs: 'tor'
  ).stdout
  # When we test for ASP upgrade failure the following tests would fail,
  # so let's skip them in this case.
  unless $vm.file_exist?('/run/live-additional-software/doomed_to_fail')
    step 'the Additional Software upgrade service has started' \
      if @additional_software_expected_to_start
    begin
      try_for(30) { $vm.execute('systemctl is-system-running').success? }
    rescue Timeout::Error
      jobs = $vm.execute('systemctl list-jobs').stdout
      units_status = $vm.execute('systemctl --all --state=failed').stdout
      raise "The system is not fully running yet:\n#{jobs}\n#{units_status}"
    end
  end
end

class TimeSyncingError < StandardError
end

class HtpdateError < TimeSyncingError
end

Given /^the time has synced$/ do
  try_for(300) { $vm.file_exist?('/run/htpdate/success') }
rescue Timeout::Error
  raise HtpdateError, 'Time syncing failed'
end

Given /^available upgrades have been checked$/ do
  try_for(300) { $vm.file_exist?('/run/tails-upgrader/checked_upgrades') }
end

Given /^all notifications have disappeared$/ do
  gnome_shell = Dogtail::Application.new('gnome-shell')
  retry_action(10, recovery_proc: proc { @screen.press('Escape') }) do
    @screen.press('super', 'v') # Show the notification list
    gnome_shell.child('Do Not Disturb',
                      roleName: 'label')
    # Check if there are notifications or if the "No Notifications"
    # label is visible. Don't retry to avoid long delays - if there are
    # no notifications, the button should be visible when the
    # "Do Not Disturb" button is visible.
    no_notifications = gnome_shell.child?(
      'No Notifications',
      roleName: 'label', retry: false
    )
    unless no_notifications
      gnome_shell.child('Clear all notifications', roleName: 'button').click
      gnome_shell.child?('No Notifications', roleName: 'label')
    end
  end
  # Close the notification list
  retry_action(5) do
    @screen.press('Escape')
    !gnome_shell.child?('Do Not Disturb',
                        roleName: 'label', retry: false)
  end
  # Increase the chances that by the time we leave this step, the
  # notifications menu was closed and the desktop is back to its
  # normal state. Otherwise, all kinds of trouble may arise: for
  # example, pressing SUPER to open the Activities Overview sometimes
  # fails (SUPER has no effect when the notifications menu is still
  # opened). We sleep here, instead of in "I start […] via GNOME
  # Activities Overview", because it's our responsibility to return to
  # a normal desktop state that any following step can rely upon.
  sleep 1
end

Then /^I (do not )?see "([^"]*)" after at most (\d+) seconds$/ do |negation, image, time|
  if negation
    @screen.wait_vanish(image, time.to_i)
  else
    @screen.wait(image, time.to_i)
  end
end

Given /^I enter the sudo password in the GNOME authentication prompt$/ do
  step "I enter the \"#{@sudo_password}\" password in the GNOME authentication prompt"
end

def gnome_shell_unlock_dialog(title = 'Authentication Required')
  d = Dogtail::Application.new('gnome-shell')
                          .child(title, roleName: 'label')
                          .parent.parent.parent.parent.parent.parent.parent
  assert_equal('dialog', d.roleName)
  d
end

def gnome_shell_unlock_dialog?(title = 'Authentication Required')
  Dogtail::Application.new('gnome-shell')
                      .child?(
                        title,
                        roleName: 'label',
                        retry:    false
                      )
end

def deal_with_polkit_prompt(password, **opts)
  opts[:expect_success] = true if opts[:expect_success].nil?
  opts[:title] = 'Authentication Required' if opts[:title].nil?
  dialog = gnome_shell_unlock_dialog(opts[:title])
  dialog.child('', roleName: 'password text').text = password
  @screen.press('Return')
  if opts[:expect_success]
    try_for(20) { !gnome_shell_unlock_dialog?(opts[:title]) }
  else
    # Using Dogtail for this one is not trivial: the error message is
    # seen as "showing" by Dogtail even when it's not visible on
    # screen, and I could find no way to tell whether it's
    # actually displayed.
    @screen.wait('PolicyKitAuthFailure.png', 20)
    # Ensure the dialog is ready to handle whatever else
    # we want to do with it next, such as pressing Escape
    sleep 0.5
  end
end

Given /^I enter the "([^"]*)" password in the GNOME authentication prompt$/ do |password|
  deal_with_polkit_prompt(password)
end

Given /^I cancel the GNOME authentication prompt$/ do
  gnome_shell_unlock_dialog
  @screen.press('escape')
  try_for(20) { !gnome_shell_unlock_dialog? }
end

Given /^process "([^"]+)" is (not )?running$/ do |process, not_running|
  if not_running
    assert(!$vm.process_running?(process), "Process '#{process}' is running")
  else
    assert($vm.process_running?(process), "Process '#{process}' is not running")
  end
end

Given /^process "([^"]+)" is running within (\d+) seconds$/ do |process, time|
  try_for(time.to_i, msg: "Process '#{process}' is not running after " \
                             "waiting for #{time} seconds") do
    $vm.process_running?(process)
  end
end

Given /^process "([^"]+)" has stopped running after at most (\d+) seconds$/ do |process, time|
  try_for(time.to_i, msg: "Process '#{process}' is still running after " \
                             "waiting for #{time} seconds") do
    !$vm.process_running?(process)
  end
end

def ensure_process_is_terminated(process)
  $vm.execute("killall #{process}")
  try_for(10, msg: "Process '#{process}' could not be killed") do
    !$vm.process_running?(process)
  end
end

Then /^Tails eventually (shuts down|restarts)$/ do |mode|
  try_for(3 * 60) do
    if mode == 'restarts'
      @screen.find('TailsGreeter.png')
    elsif !$vm.running?
      # The VM has shut down as expected
    else
      # It sometimes happens that the VM automatically restarts after
      # shutdown. To avoid the test failing in that case, we also check
      # here if we see the greeter and in that case force a shutdown of
      # the VM.
      @screen.find('TailsGreeter.png')
      $vm.power_off
    end
    true
  end
end

Given /^I shutdown Tails and wait for the computer to power off$/ do
  $vm.spawn('systemctl poweroff')
  step 'Tails eventually shuts down'
end

def open_gnome_menu(name)
  Dogtail::Application.new('gnome-shell')
                      .child(name, roleName: 'menu')
                      .click
end

def toggle_gnome_system_menu
  open_gnome_menu('System')
end

When /^I request a (shutdown|reboot) using the system menu$/ do |action|
  gnome_shell = Dogtail::Application.new('gnome-shell')
  toggle_gnome_system_menu
  menu_item_name = if action == 'shutdown'
                     'Power Off'
                   else
                     'Restart'
                   end
  # If we .click() using Dogtail we risk losing the connection with
  # the remote shell before it sends the response, leading to a
  # time-consuming RemoteShell::Timeout.
  @screen.click(*gnome_shell.child(menu_item_name, roleName: 'label').position)
end

When /^I warm reboot the computer$/ do
  $vm.spawn('reboot')
end

Given /^the package "([^"]+)" is( not)? installed( after Additional Software has been started)?$/ do |package, absent, asp|
  if absent
    wait_for_package_removal(package)
  else
    step 'the Additional Software installation service has started' if asp
    wait_for_package_installation(package)
  end
end

Given /^I add a ([a-z0-9.]+ |)wired DHCP NetworkManager connection called "([^"]+)"$/ do |version, con_name|
  raise "Unsupported version '#{version}'" unless version.empty?

  $vm.execute_successfully(
    "nmcli connection add con-name #{con_name} " \
    'type ethernet autoconnect yes ifname eth0'
  )

  try_for(10) do
    nm_con_list = $vm.execute('nmcli --terse --fields NAME connection show')
                     .stdout
    nm_con_list.split("\n").include? con_name.to_s
  end
end

Given /^I switch to the "([^"]+)" NetworkManager connection$/ do |con_name|
  $vm.execute("nmcli connection up id #{con_name}")
  try_for(60) do
    $vm.execute(
      'nmcli --terse --fields NAME,STATE connection show'
    ).stdout.chomp.split("\n").include?("#{con_name}:activated")
  end
end

When /^I run "([^"]+)" in Console$/ do |command|
  app = if $vm.process_running?('kgx')
          Dogtail::Application.new('kgx')
        else
          launch_console
        end
  terminal = app.child('Terminal', roleName: 'terminal')
  try_for(5) { !terminal.text.strip.split("\n").last['amnesia@amnesia:'].nil? }
  try_for(20) do
    @screen.paste(command, app: :console)
    if terminal.text.strip.split("\n").last[command]
      # The command was pasted successfully
      true
    else
      debug_log('Error while pasting; trying again...')
      # The command was not pasted successfully. Close the terminal and
      # open a new one.
      app.child('Close', roleName: 'button').click
      app = launch_console
      terminal = app.child('Terminal', roleName: 'terminal')
      try_for(5) { !terminal.text.strip.split("\n").last['amnesia@amnesia:'].nil? }
      false
    end
  end

  @screen.press('Return')
end

When /^the file "([^"]+)" exists(?:| after at most (\d+) seconds)$/ do |file, timeout|
  timeout = 10 if timeout.nil?
  try_for(
    timeout.to_i,
    msg: "The file #{file} does not exist after #{timeout} seconds"
  ) do
    $vm.file_exist?(file)
  end
end

When /^the file "([^"]+)" does not exist$/ do |file|
  assert(!$vm.file_exist?(file))
end

When /^the file "([^"]+)" is empty$/ do |file|
  assert($vm.file_exist?(file))
  assert($vm.file_empty?(file))
end

When /^the directory "([^"]+)" exists$/ do |directory|
  assert($vm.directory_exist?(directory))
end

When /^the directory "([^"]+)" does not exist$/ do |directory|
  assert(!$vm.directory_exist?(directory))
end

When /^the file "([^"]+)" has the content "([^"]+)"$/ do |file, content|
  $vm.file_content(file) == content
end

When /^I copy "([^"]+)" to "([^"]+)" as user "([^"]+)"$/ do |source, destination, user|
  c = $vm.execute("cp \"#{source}\" \"#{destination}\"", user:)
  assert(c.success?, "Failed to copy file:\n#{c.stdout}\n#{c.stderr}")
end

def persistence_active?(app)
  conf = get_tps_bindings(skip_links: true)[app.to_s]
  c = $vm.execute("findmnt --noheadings --output SOURCE --target '#{conf}'")
  c.success? && (c.stdout.chomp != 'overlay')
end

Then /^persistence for "([^"]+)" is (|not )active$/ do |app, active|
  case active
  when ''
    assert(persistence_active?(app), 'Persistence should be active.')
  when 'not '
    assert(!persistence_active?(app), 'Persistence should not be active.')
  end
end

def language_has_non_latin_input_source(language)
  # NOTE: we'll have to update the list when fixing #12638 or #18076
  ['Persian', 'Russian'].include?(language)
end

# In the situations where we call this method
# (language_has_non_latin_input_source), we have exactly 2 input
# sources, so calling this method switches back and forth
# between them.
def switch_input_source
  @screen.press('super', 'space')
  sleep 1
end

def launch_app(desktop_file_name, app_name, user: LIVE_USER, timeout: 30,
               check_started: true)
  # We use systemd-run to launch the app, because we want the app to run
  # in the active systemd login session, so that polkit rules for active
  # sessions apply to it.
  cmd = ['systemd-run', '--user',
         '--remain-after-exit',
         '/usr/local/bin/gtk-abspath-launch',
         "/usr/share/applications/#{desktop_file_name}",].join(' ')
  $vm.execute(cmd, user:)
  return unless check_started

  app = nil
  try_for(timeout) do
    app = Dogtail::Application.new(app_name)
  end
  app
end

def launch_gnome_disks(**opts)
  launch_app(
    'org.gnome.DiskUtility.desktop',
    'gnome-disks',
    **opts
  )
end

def launch_console(**opts)
  launch_app(
    'org.gnome.Console.desktop',
    'kgx',
    **opts
  )
end

def launch_nautilus(**opts)
  launch_app(
    'org.gnome.Nautilus.desktop',
    'org.gnome.Nautilus',
    **opts
  )
end

def launch_persistent_storage(**opts)
  launch_app(
    'org.boum.tails.PersistentStorage.desktop',
    'tps-frontend',
    **opts
  )
end

def launch_tails_backup(**opts)
  launch_app(
    'tails-backup.desktop',
    'zenity',
    **opts
  )
end

def launch_thunderbird(**opts)
  launch_app(
    'thunderbird.desktop',
    'Thunderbird',
    **opts
  )
end

def launch_tor_browser(**opts)
  launch_app(
    'org.boum.tails.TorBrowser.desktop',
    'Firefox',
    timeout: 60,
    **opts
  )
end

def launch_unlock_veracrypt_volumes(**opts)
  launch_app(
    'unlock-veracrypt-volumes.desktop',
    'unlock-veracrypt-volumes',
    **opts
  )
end

def launch_unsafe_browser(**opts)
  opts[:timeout] ||= 60
  launch_app(
    'unsafe-browser.desktop',
    'Firefox',
    **opts
  )
end

Given /^I start "([^"]+)" via GNOME Activities Overview$/ do |app_name|
  # Search disambiguation: below we assume that there is only one
  # result, since multiple results introduces a race that leads to a
  # non-deterministic choice (at least under load). To make the life
  # easier for users of this step, let's collect workarounds here.
  case app_name
  when 'Persistent Storage'
    # "Persistent Storage" also matches "Back Up Persistent Storage"
    # (tails-backup.desktop).
    app_name = 'tails-persistent-storage'
  end
  @screen.wait(gnome_activities_overview_image, 10)
  @screen.press('super')
  pic = if RTL_LANGUAGES.include?($language)
          'GnomeActivitiesOverviewSearchRTL.png'
        else
          'GnomeActivitiesOverviewSearch.png'
        end
  @screen.wait(pic, 20)
  if language_has_non_latin_input_source($language)
    # Temporarily switch to en_US keyboard layout to type the name of the app
    switch_input_source
  end
  # Trigger startup of search providers
  @screen.type(app_name[0])
  # Give search providers some time to start (#13469#note-5) otherwise
  # our search sometimes returns no results at all.
  sleep 2
  # Type the rest of the search query
  @screen.type(app_name[1..])
  sleep 4
  @screen.press('ctrl', 'Return')
  if language_has_non_latin_input_source($language)
    # Switch back to $language's default keyboard layout
    switch_input_source
  end
end

When /^I close the "([^"]+)" window$/ do |app_name|
  app = nil
  try_for(60) do
    app = Dogtail::Application.new(app_name)
  end

  close_button = case app_name
                 when 'zenity'
                   app.children(roleName: 'button')
                      .find { |n| ['cancel', 'close', 'ok'].include?(n.name.downcase) }
                 else
                   app.child(
                     'Close',
                     roleName:    'button',
                     # For some reason, the 'showing' attribute of the close button is
                     # false in some apps (e.g. Nautilus), even though it's visible.
                     showingOnly: false
                   )
                 end

  close_button.click

  # Wait for the app to terminate (some apps take a while to actually
  # terminate after the window is closed, for example GNOME Files).
  try_for(60) do
    assert_raises(Dogtail::Failure) do
      Dogtail::Application.new(app_name, retry: false)
    end
  end
end

When /^I close the "([^"]+)" window via Alt\+F4$/ do |app_name|
  # Check that the app is running
  Dogtail::Application.new(app_name)

  try_for(60) do
    @screen.press('alt', 'F4')
    assert_raises(Dogtail::Failure) do
      Dogtail::Application.new(app_name, retry: false)
    end
  end
end

When /^I close Console$/ do
  console = Dogtail::Application.new('kgx')
  console.button('Close').click
  # Console asks for confirmation if a command is still
  # running. Sometimes it thinks a command that just exited is still
  # running, so it shows the confirmation dialog unexpectedly, so we
  # always have to anticipate it.
  try_for(10) do
    Dogtail::Application.new('kgx', retry: false)
  rescue Dogtail::Failure
    true
  else
    console.child('Close Window?', roleName: 'alert',
                                   retry:    false).button('Close').click
    false
  end
end

When /^I press the "([^"]+)" key$/ do |key|
  @screen.press(key)
end

Then /^the live user's (.*) directory (exists|does not exist)$/ do |directory, mode|
  step "the directory \"/home/#{LIVE_USER}/#{directory}\" #{mode}"
end

Then /^there is a GNOME bookmark for the (.*) directory$/ do |bookmark|
  launch_nautilus
  # We cannot pass translation_domain to the Dogtail::Application
  # because then it would also translate the bookmark, but we don't do
  # that for XDG user dirs (tails#20868).
  Dogtail::Application.new('org.gnome.Nautilus')
                      .child(translate('Sidebar', translation_domain: 'nautilus'),
                             roleName: 'list')
                      .child(bookmark, roleName: 'label')
  step 'I close the "org.gnome.Nautilus" window via Alt+F4'
end

def pipewire_input_ports
  pa_info = $vm.execute(
    'pw-link --links | grep "<-"', user: LIVE_USER
  ).stdout.chomp
  pa_info.split("\n").length
end

Given /^a web server is running on the LAN$/ do
  # Start a new web server unless one is already running
  unless @web_server_url
    start_web_server
  end
end

def start_web_server
  @web_server_ip_addr = $vmnet.bridge_ip_address.to_s
  @web_server_port = 8000
  @web_server_url = "http://#{@web_server_ip_addr}:#{@web_server_port}"

  # Ensure that the LAN web server data directory is empty
  FileUtils.rm_rf(LAN_WEB_SERVER_DATA_DIR)
  FileUtils.mkdir_p(LAN_WEB_SERVER_DATA_DIR)

  @captive_portal_login_file = "#{LAN_WEB_SERVER_DATA_DIR}/logged-in"
  @lan_web_server_headers_dir = "#{LAN_WEB_SERVER_DATA_DIR}/headers"

  add_extra_allowed_host(@web_server_ip_addr, @web_server_port)

  _, out, proc = Open3.popen2e(
    "#{GIT_DIR}/features/scripts/lan-web-server",
    '--address', @web_server_ip_addr,
    '--port', @web_server_port.to_s,
    '--hello-message', LAN_WEB_SERVER_HELLO_MSG,
    '--data-dir', LAN_WEB_SERVER_DATA_DIR
  )

  # Log all the web server output (stdout and stderr) to the debug log
  Thread.new do
    out.each_line do |line|
      debug_log("LAN web server: #{line}")
    end
  end

  try_for(10, msg: 'It seems the LAN web server failed to start') do
    Process.kill(0, proc.pid) == 1
  end

  add_after_scenario_hook do
    Process.kill('TERM', proc.pid)
    begin
      Process.wait(proc.pid)
    rescue Errno::ECHILD
      # The web server was killed before we started wait():ing!
    end
  end

  # It seems necessary to actually check that the LAN server is
  # serving, possibly because it isn't doing so reliably when setting
  # up. If e.g. the Unsafe Browser (which *should* be able to access
  # the web server) tries to access it too early, Firefox seems to
  # take some random amount of time to retry fetching. Curl gives a
  # more consistent result, so let's rely on that instead.
  try_for(30, msg: 'Something is wrong with the LAN web server') do
    # Use /usr/bin/curl instead of our curl wrapper script because the
    # wrapper script makes curl use Tor and we want to access the LAN.
    msg = cmd_helper(['curl', '--silent', '--fail', @web_server_url])
    msg.include?(LAN_WEB_SERVER_HELLO_MSG)
  end

  # Remove the header file that was saved by the web server for the
  # previous request (we just remove all files in the headers directory
  # because we don't know the filename and there shouldn't be any other
  # files in there anyway).
  FileUtils.rm_f(Dir.glob("#{@lan_web_server_headers_dir}/*"))
end

When /^I open a page on the LAN web server in the (.*)$/ do |browser|
  step "I open the address \"#{@web_server_url}\" in the #{browser}"
end

Then /^no traffic was sent to the web server on the LAN$/ do
  assert_no_connections(@sniffer.pcap_file) do |c|
    (c.daddr == @web_server_ip_addr) && (c.dport == @web_server_port)
  end
end

Given /^I wait (?:between (\d+) and )?(\d+) seconds$/ do |min, max|
  time = if min
           rand(max.to_i - min.to_i + 1) + min.to_i
         else
           max.to_i
         end
  puts "Slept for #{time} seconds"
  sleep(time)
end

Given /^I (?:re)?start monitoring the AppArmor log of "([^"]+)"$/ do |profile|
  # AppArmor log entries may be dropped if printk rate limiting is
  # enabled.
  $vm.execute_successfully('sysctl -w kernel.printk_ratelimit=0')
  # We will only care about entries for this profile from this time
  # and on.
  guest_time = $vm.execute_successfully(
    'date +"%Y-%m-%d %H:%M:%S"'
  ).stdout.chomp
  @apparmor_profile_monitoring_start ||= {}
  @apparmor_profile_monitoring_start[profile] = guest_time
end

When /^AppArmor has (not )?denied "([^"]+)" from opening "([^"]+)"$/ do |anti_test, profile, file|
  assert(@apparmor_profile_monitoring_start &&
         @apparmor_profile_monitoring_start[profile],
         "It seems the profile '#{profile}' isn't being monitored by the " \
         "'I monitor the AppArmor log of ...' step")
  audit_line_regex = format(
    'apparmor="DENIED".*operation="open".*profile="%<profile>s".*name="%<file>s"',
    profile:,
    file:
  )
  begin
    try_for(10, delay: 1) do
      audit_log = systemd_journal(
        audit_line_regex,
        regexp:  true,
        options: ["--since='#{@apparmor_profile_monitoring_start[profile]}'"],
        matches: ['SYSLOG_IDENTIFIER=kernel']
      )
      audit_log.empty? == (anti_test ? true : false)
    end
  rescue Timeout::Error, Test::Unit::AssertionFailedError => e
    raise e, "AppArmor has #{anti_test ? '' : 'not '}denied the operation"
  end
end

Then /^I force Tor to use a new circuit$/ do
  force_new_tor_circuit
end

When /^I eject the boot medium$/ do
  dev = boot_device
  dev_type = device_info(dev)['ID_TYPE']
  case dev_type
  when 'cd'
    $vm.eject_cdrom
  when 'disk'
    boot_disk_name = $vm.disk_name(dev)
    $vm.unplug_drive(boot_disk_name)
  else
    raise "Unsupported medium type '#{dev_type}' for boot device '#{dev}'"
  end
end

Given /^Tails is fooled to think it is running version (.+)$/ do |version|
  $vm.execute_successfully(
    'sed -i ' \
    "'s/^VERSION=.*$/VERSION=\"#{version}\"/' " \
    '/etc/os-release'
  )
end

Given /^Tails is fooled to think that version (.+) was initially installed$/ do |version|
  initial_os_release_file =
    '/lib/live/mount/rootfs/filesystem.squashfs/etc/os-release'
  fake_os_release_file = $vm.execute_successfully('mktemp').stdout.chomp
  fake_os_release_content = <<~OSRELEASE
    NAME="Tails"
    VERSION="#{version}"
  OSRELEASE
  $vm.file_overwrite(fake_os_release_file, fake_os_release_content)
  $vm.execute_successfully("chmod a+r #{fake_os_release_file}")
  $vm.execute_successfully(
    "mount --bind '#{fake_os_release_file}' '#{initial_os_release_file}'"
  )
  # Let's verify that the deception works
  assert_equal(
    version,
    $vm.execute_successfully(
      ". #{initial_os_release_file} && echo ${VERSION}"
    ).stdout.chomp,
    'Implementation error, alert the test suite maintainer!'
  )
end

Then /^Tails is running version (.+)$/ do |version|
  running_version = $vm.file_content('/etc/os-release')
                       .match(/^VERSION="(.+)"$/)[1]
  assert_equal(
    version,
    running_version,
    "The version doesn't match /etc/os-release"
  )
end

def size_of_shared_disk_for(files)
  files = [files] if files.instance_of?(String)
  assert_equal(Array, files.class)
  disk_size = files.map { |f| File.new(f).size }.reduce(0, :+)
  # Let's add some extra space for filesystem overhead etc.
  disk_size += [convert_to_bytes(16, 'MiB'), (disk_size * 0.15).ceil].max
  disk_size
end

def share_host_files(files)
  files = [files] if files.instance_of?(String)
  assert_equal(Array, files.class)
  disk_size = size_of_shared_disk_for(files)
  disk = random_alpha_string(10)
  step "I temporarily create an #{disk_size} bytes disk named \"#{disk}\""
  step "I create a gpt partition labeled \"#{disk}\" with an ext4 " \
       "filesystem on disk \"#{disk}\""
  $vm.storage.guestfs_disk_helper(disk) do |g, _|
    partition = g.list_partitions.first
    g.mount(partition, '/')
    files.each { |f| g.upload(f, "/#{File.basename(f)}") }
  end
  step "I plug USB drive \"#{disk}\""
  mount_dir = $vm.execute_successfully('mktemp -d').stdout.chomp
  dev = $vm.disk_dev(disk)
  partition = "#{dev}1"
  $vm.execute_successfully("mount #{partition} #{mount_dir}")
  $vm.execute_successfully("chmod -R a+rX '#{mount_dir}'")
  mount_dir
end

def mount_usb_drive(disk, **fs_options)
  fs_options[:encrypted] ||= false
  mount_dir = $vm.execute_successfully('mktemp -d').stdout.chomp
  dev = $vm.disk_dev(disk)
  partition = "#{dev}1"
  if fs_options[:encrypted]
    password = fs_options[:password]
    assert_not_nil(password)
    luks_mapping = "#{disk}_unlocked"
    $vm.execute_successfully(
      "echo #{password} | " \
      "cryptsetup luksOpen #{partition} #{luks_mapping}"
    )
    $vm.execute_successfully(
      "mount /dev/mapper/#{luks_mapping} #{mount_dir}"
    )
  else
    $vm.execute_successfully("mount #{partition} #{mount_dir}")
  end
  mount_dir
end

When(/^I plug and mount a (\d+) MiB USB drive with an? (.*)$/) do |size_MiB, fs|
  disk_size = convert_to_bytes(size_MiB.to_i, 'MiB')
  disk = random_alpha_string(10)
  step "I temporarily create an #{disk_size} bytes disk named \"#{disk}\""
  step "I create a gpt partition labeled \"#{disk}\" with " \
       "an #{fs} on disk \"#{disk}\""
  step "I plug USB drive \"#{disk}\""
  device = $vm.disk_dev(disk)
  partition = "#{device}1"
  mount_dir = nil
  fs_options = {}
  fs_options[:filesystem] = /(.*) filesystem/.match(fs)[1]
  if /\bencrypted with password\b/.match(fs)
    fs_options[:encrypted] = true
    fs_options[:password] = /encrypted with password "([^"]+)"/.match(fs)[1]
  end
  # GNOME auto-mounts removable media, except encrypted devices that
  # need to be manually unlocked with the GNOME password prompt that
  # automatically appears
  if fs_options[:encrypted]
    deal_with_polkit_prompt(fs_options[:password])
  end
  # Wait for GNOME to (maybe unlock) and mount
  try_for(20) do
    mount_dir = mountpoint(partition)
    !mount_dir.nil?
  end
  @tmp_filesystem_disk = disk
  @tmp_filesystem_options = fs_options
  @tmp_filesystem_size_b = avail_space_in_mountpoint(mount_dir)
  @tmp_usb_drive_mount_dir = mount_dir
end

When(/^I mount the USB drive again$/) do
  @tmp_usb_drive_mount_dir = mount_usb_drive(@tmp_filesystem_disk,
                                             **@tmp_filesystem_options)
end

When(/^I umount the USB drive$/) do
  device = $vm.execute_successfully(
    "findmnt --noheadings --output SOURCE #{@tmp_usb_drive_mount_dir}"
  ).stdout
  $vm.execute_successfully("umount #{device}")
  if @tmp_filesystem_options[:encrypted]
    $vm.execute_successfully("cryptsetup luksClose #{device}")
  end
end

When /^Tails system time is magically synchronized$/ do
  $vm.host_to_guest_time_sync
end

def reload_code(path_glob)
  # When reloading step definitions all of them will become
  # ambiguous since there is an existing one with matching an
  # identical pattern. So we enable cucumber's --guess option which
  # we have monkeypatched to use the last (loaded) definition.
  $cucumber_options[:guess] = true
  # This will enable the monkeypatch handling step redefinitions
  $cucumber_options[:redefine_steps] = true
  # Some tests (e.g. those tagged @source) change the current working
  # directory so the glob below finds nothing unless we restore it to
  # the usual GIT_DIR. Also, we want the glob to result in relative
  # paths from GIT_DIR to match how they are loaded by cucumber at the
  # test suite initialization.
  Dir.chdir(GIT_DIR) do
    Dir.glob(path_glob).each { |file| load(file) }
  end
  nil
end

def reload_step_definitions
  reload_code('features/step_definitions/**/*.rb')
end

def reload_all_code
  reload_code('features/**/*.rb')
end

When /^I reload step definitions$/ do
  reload_step_definitions
end

When /^I reload all code$/ do
  reload_all_code
end

# Useful for debugging scenarios: e.g. inject this step in a scenario
# at some point when you want to investigate the state.
When /^I pause( and then reload step definitions)?$/ do |reload|
  pause(quiet: true)
  step 'I reload step definitions' if reload
end

When /^I apply changes$/ do
  $vm.late_patch
end

# Useful for debugging Tails features: let's say you want to fix a bug
# exposed by $SCENARIO, and is working on a fix in $FILE locally. To
# immediately test your fix, simply inject this step into $SCENARIO,
# so that $FILE is put in place (obviously this depends on that no
# extra steps are needed to make $FILE's changes go "live").
When /^I upload "([^"]*)" to "([^"]*)"$/ do |source, destination|
  [source, destination].each { |s| s.sub!(%r{/*$}, '') }
  Dir.glob(source).each do |path|
    if File.directory?(path)
      new_destination = "#{destination}/#{File.basename(path)}"
      $vm.execute_successfully("mkdir -p '#{new_destination}'")
      Dir.new(path).each do |child|
        next if (child == '.') || (child == '..')

        step "I upload \"#{path}/#{child}\" to \"#{new_destination}\""
      end
    else
      File.open(path) do |f|
        final_destination = destination
        if $vm.directory_exist?(final_destination)
          final_destination += "/#{File.basename(path)}"
        end
        $vm.file_overwrite(final_destination, f.read)
      end
    end
  end
end

# Useful for debugging Tails features, because it causes the journal
# etc. to be downloaded to the host and then, if run with
# --interactive-debugging, allows to manually debug the VM.
When /^this test fails$/ do
  raise 'This step is supposed to fail'
end

When /^I disable the (.*) (system|user) unit$/ do |unit, scope|
  options = scope == 'system' ? '' : '--global'
  $vm.execute_successfully("systemctl #{options} disable '#{unit}'")
end

def git_on_a_tag
  system('git describe --tags --exact-match HEAD >/dev/null 2>&1')
end

def git_current_tag
  `git describe --tags --exact-match HEAD`.chomp
end

Then /^the keyboard layout is set to "([^"]+)"$/ do |keyboard_layout|
  input_sources = $vm.execute_successfully(
    'gsettings get org.gnome.desktop.input-sources sources',
    user: LIVE_USER
  ).stdout
  input_countrycode = input_sources.scan(/\('([^']*)', '([^']*)'\)/).first.last
  assert_equal(keyboard_layout, input_countrycode)

  mru_sources = $vm.execute_successfully(
    'gsettings get org.gnome.desktop.input-sources mru-sources',
    user: LIVE_USER
  ).stdout.chomp
  if mru_sources != '@a(ss) []'
    mru_countrycode = mru_sources.scan(/\('([^']*)', '([^']*)'\)/).first.last
    assert_equal(keyboard_layout, mru_countrycode)
  end
end

When /^I enable the screen keyboard$/ do
  $vm.execute_successfully(
    'gsettings set org.gnome.desktop.a11y.applications ' \
    'screen-keyboard-enabled true',
    user: LIVE_USER
  )
end

Then(/^the layout of the screen keyboard is set to "([^"]+)"$/) do |layout|
  @screen.find("ScreenKeyboardLayout#{layout.upcase}.png")
end

Then /^tpsd is localized to the selected locale$/ do
  locale = $vm.execute_successfully('echo $LANG').stdout.chomp
  tpsd_locale_changes = systemd_journal(
    'Changed locale: .*',
    regexp:  true,
    options: ['--unit=tails-persistent-storage.service'],
    matches: ['SYSLOG_IDENTIFIER=tpsd']
  )
  # If we never change from the default locale nothing will be logged
  next if locale == 'en_US.UTF-8' && tpsd_locale_changes.empty?

  assert_not_nil(
    tpsd_locale_changes.split("\n").last[/Changed locale: .* → #{locale}/]
  )
end

Given /^I create a directory "(\S+)"$/ do |path|
  $vm.execute_successfully("mkdir '#{path}'")
end

Given /^I write a file "(\S+)" with contents "([^"]*)"$/ do |path, content|
  $vm.file_overwrite(path, content)
end

Given /^I change ownership of file "(\S+)" to "([^"]*)"$/ do |path, owner|
  $vm.execute_successfully("chown #{owner} #{path}")
end

Given /^I create a symlink "(\S+)" to "(\S+)"$/ do |link, target|
  $vm.execute_successfully(
    "ln -s --no-target-directory '#{target}' '#{link}'"
  )
end

def select_path_in_file_chooser(file_chooser, path, button_label: 'Open')
  assert_equal('file chooser', file_chooser.roleName)
  try_for(10) do
    @screen.press('ctrl', 'l')
    file_chooser.focused_child.roleName == 'text'
  end
  file_chooser.focused_child.text = path
  try_for(10) { file_chooser.button(button_label).sensitive? }
  file_chooser.button(button_label).click
  try_for(10) { !file_chooser.showing? }
end

def save_qrcode(str)
  # Generate a QR code similar enough to BridgeDB's:
  # https://gitlab.torproject.org/tpo/anti-censorship/bridgedb/-/blob/main/bridgedb/qrcodes.py
  qrencode_output_file = Tempfile.create('qrcode', $config['TMPDIR'])
  qrencode_output_file.close
  output_file = "#{qrencode_output_file.path}.jpg"
  cmd_helper(['qrencode', '-o', qrencode_output_file.path, '--size=5', '--margin=5',
              str,])
  assert(File.exist?(qrencode_output_file.path))
  cmd_helper(['convert', qrencode_output_file.path, output_file])
  assert(File.exist?(output_file))
  output_file
end

Given /^I write (|an old version of )the Tails (ISO|USB) image to disk "([^"]+)"$/ do |old, type, name|
  if old != ''
    match = /^tails-amd64-(\d+[.]\d+(?:[.]\d+)?)[.]img$/
            .match(File.basename(OLD_TAILS_IMG))
    $old_version = match.nil? ? nil : match[1]
    if $old_version.nil?
      debug_log('Failed to extract old version. This is expected, and OK,' \
                'if you passed anything but a stable release to --old-iso')
    else
      debug_log("Old version: #{$old_version}")
    end
  end
  src_disk = {
    path: (if old == ''
             type == 'ISO' ? TAILS_ISO : TAILS_IMG
           else
             type == 'ISO' ? OLD_TAILS_ISO : OLD_TAILS_IMG
           end
          ),
    opts: {
      format:   'raw',
      readonly: true,
    },
  }
  dest_disk = {
    path: $vm.storage.disk_path(name),
    opts: {
      format: $vm.storage.disk_format(name),
    },
  }
  $vm.storage.guestfs_disk_helper(
    src_disk,
    dest_disk
  ) do |g, src_disk_handle, dest_disk_handle|
    g.copy_device_to_device(src_disk_handle, dest_disk_handle, {})
  end
end

Then /^running "([^"]+)" as user "([^"]+)" succeeds$/ do |command, user|
  c = $vm.execute(command, user:)
  assert(c.success?, "Failed to run command:\n#{c.stdout}\n#{c.stderr}")
end

Then /^running "([^"]+)" as user "([^"]+)" fails$/ do |command, user|
  c = $vm.execute(command, user:)
  assert(
    !c.success?,
    "Success running command when we were expecting failure:\n#{c.stdout}\n#{c.stderr}"
  )
end

# In many cases this is superior to a naive "journalctl | grep", which
# will find itself because tails-autotest-remote-shell logs the
# commands its executes.
def systemd_journal(message, options: [], matches: [], regexp: false)
  # Below we'll quote this string with apostrophes when passed to the
  # shell, so let's escape: ' → \'
  message.gsub!("'", "\\\\'")
  # We avoid modifying the caller's data
  final_options = options.clone
  final_matches = matches.clone
  if regexp
    final_options.append("--grep='#{message}'")
  else
    final_matches.append("MESSAGE='#{message}'")
  end
  $vm.execute(
    'journalctl --boot --output=cat ' \
    "#{final_options.join(' ')} " \
    "#{final_matches.join(' ')}"
  ).stdout
end

def systemd_journal_includes?(*args, **opts)
  !systemd_journal(*args, **opts).empty?
end

Then /^WhisperBack is prefilled for (.*) with summary: "(.*)"$/ do |app, summary|
  whisperback = Dogtail::Application.new('whisperback')
  prefilled_checkbox = whisperback.child('information about the error being reported',
                                         showingOnly: false)
  assert(prefilled_checkbox.checked?)
  prefilled_text = prefilled_checkbox.parent.child(roleName:    'text',
                                                   showingOnly: false).text
  assert_equal("Bug-specific app: #{app}\nBug-specific summary: #{summary}\n",
               prefilled_text)
end

Then /^the language and keyboard have not been saved in cleartext storage$/ do
  # Give it some time, otherwise the subsequent tests could pass just because
  # the file hasn't been created *yet*
  sleep 2
  assert_false($vm.file_exist?('/usr/lib/live/mount/medium/storage/language'))
  assert_false($vm.file_exist?('/usr/lib/live/mount/medium/storage/keyboard'))
end

Then /^the "(\w\w)" language and keyboard have been saved in cleartext storage$/ do |lang|
  expected_keyboard = lang
  expected_locale = { 'it' => 'it_IT', 'fr' => 'fr_FR' }[lang]
  try_for(10) do
    $vm.file_exist?('/usr/lib/live/mount/medium/storage/language') && \
      $vm.file_exist?('/usr/lib/live/mount/medium/storage/keyboard')
  end
  try_for(10) do
    language = JSON.parse(
      $vm.file_content('/usr/lib/live/mount/medium/storage/language')
    )
    expected_locale == language['TAILS_LOCALE_NAME']
  end
  try_for(10) do
    keyboard = JSON.parse(
      $vm.file_content('/usr/lib/live/mount/medium/storage/keyboard')
    )
    expected_keyboard == keyboard['TAILS_XKBLAYOUT']
  end
end

Then(/^the Welcome Screen's language is set to (.*)$/) do |lang|
  language_row = greeter.children(roleName: 'list item')
                        .first
                        .children(roleName: 'label')
                        .find { |node| node.name.include?("#{lang} - ") }
  assert_not_nil(language_row)
  # That's a good moment to refresh this information, so the next steps don't fail
  $language, $lang_code = greeter_language
end

Then(/^the Welcome Screen's formats is set to (.*)$/) do |lang|
  formats_row = greeter.children(roleName: 'list item')[2]
                       .children(roleName: 'label')
                       .find { |node| node.name.include?("#{lang} - ") }
  assert_not_nil(formats_row)
end

Then(/^the language is set to (.*)$/) do |language|
  lang = { 'French' => 'fr_FR.UTF-8' }[language]
  assert_equal(lang, $vm.execute_successfully('echo $LANG').stdout.chomp)
end

def zenity_dialog_click_button(title, button_label)
  button = Dogtail::Application.new('zenity').dialog(title).button(button_label)
  # Sometimes this click is lost. Maybe the dialog is not fully setup yet?
  sleep 2
  button.click
end

When(/^I click "([^"]+)" in the "([^"]+)" zenity dialog$/) do |button_label, title|
  zenity_dialog_click_button(title, button_label)
end

When(/^I open "(.*[.].*)" in Files$/) do |filename|
  nautilus = Dogtail::Application.new('org.gnome.Nautilus')
  nautilus.child(filename, roleName: 'table cell').click
  @screen.press('Return')
end

When(/^I wait until (?:(\w+)'s )(.*[.]service) has completed$/) do |user, unit|
  cmd = if user
          "systemctl --user is-active #{unit}"
        else
          "systemctl is-active #{unit}"
        end
  user = 'root' if user.empty?
  try_for(60) do
    output = $vm.execute_successfully(cmd, user:).stdout.strip
    output == 'active'
  end
end
