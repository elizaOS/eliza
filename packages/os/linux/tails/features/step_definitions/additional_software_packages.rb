Then /^the Additional Software (upgrade|installation) service has started$/ do |service|
  case service
  when 'installation'
    service_name = 'tails-additional-software-install.service'
    seconds_to_wait = 600
  when 'upgrade'
    service_name = 'tails-additional-software-upgrade.service'
    seconds_to_wait = 900
  end
  try_for(seconds_to_wait, delay: 10) do
    $vm.execute("systemctl status #{service_name}").success?
  end
end

Then /^I am notified I can not use Additional Software for "([^"]*)"$/ do |package|
  title = "You could install #{package} automatically when starting Tails"
  step "I see the \"#{title}\" notification after at most 300 seconds"
end

Then /^I am notified that the installation succeeded$/ do
  title = 'Additional software installed successfully'
  step "I see the \"#{title}\" notification after at most 300 seconds"
end

Then /^I am proposed to add the "([^"]*)" package to my Additional Software$/ do |package|
  title = "Add #{package} to your additional software?"
  step "I see the \"#{title}\" notification after at most 300 seconds"
end

# Only works for the notification that is currently showing
def click_gnome_shell_notification_button(title)
  Dogtail::Application.new('gnome-shell')
                      .child(roleName: 'notification')
                      .child(title, roleName: 'button')
                      .click
end

Then /^I create a persistent storage and activate the Additional Software feature$/ do
  click_gnome_shell_notification_button('Create Persistent Storage')
  step 'I create a persistent partition for Additional Software'
  assert_additional_software_persistent_storage_feature_is_enabled
end

def assert_additional_software_persistent_storage_feature_is_enabled
  assert persistent_storage_main_frame.child('Personal Documents', roleName: 'label')
  additional_software_switch = persistent_storage_main_frame.child(
    'Activate Additional Software',
    roleName: 'toggle button'
  )
  assert additional_software_switch.checked?
end

Then /^Additional Software is correctly configured for package "([^"]*)"$/ do |package|
  try_for(30) do
    assert($vm.file_exist?(ASP_CONF), 'ASP configuration file not found')
    step 'all persistence configuration files have safe access rights'
    assert_not_empty(
      $vm.file_glob(
        "/live/persistence/TailsData_unlocked/apt/cache/#{package}_*.deb"
      )
    )
    assert_not_empty(
      $vm.file_glob('/live/persistence/TailsData_unlocked/apt/lists/*_Packages')
    )
    $vm.execute(
      "grep --line-regexp --fixed-strings #{package} #{ASP_CONF}"
    ).success?
  end
end

Then /^"([^"]*)" is not in the list of Additional Software$/ do |package|
  assert($vm.file_exist?(ASP_CONF), 'ASP configuration file not found')
  step 'all persistence configuration files have safe access rights'
  try_for(30) do
    $vm.execute("grep \"#{package}\" #{ASP_CONF}").stdout.empty?
  end
end

When /^I (refuse|accept) (adding|removing) "(?:[^"]*)" (?:to|from) Additional Software$/ do |decision, action|
  case action
  when 'adding'
    case decision
    when 'accept'
      button_title = 'Install Every Time'
    when 'refuse'
      button_title = 'Install Only Once'
    end
  when 'removing'
    case decision
    when 'accept'
      button_title = 'Remove'
    when 'refuse'
      button_title = 'Cancel'
    end
  end
  try_for(300) do
    click_gnome_shell_notification_button(button_title)
    true
  end
end

Given /^I remove "([^"]*)" from the list of Additional Software using Additional Software GUI$/ do |package|
  asp_gui = Dogtail::Application.new('tails-additional-software-config')
  installed_package = asp_gui.child(package, roleName: 'label')
  # We can't use the click action here because this button causes a
  # modal dialog to be run via gtk_dialog_run() which causes the
  # application to hang when triggered via a ATSPI action. See
  # https://gitlab.gnome.org/GNOME/gtk/-/issues/1281
  installed_package.parent.parent.child('Remove', roleName: 'button').grabFocus
  @screen.press('Return')
  asp_gui.child('Question', roleName: 'alert').button('Remove').click
  deal_with_polkit_prompt(@sudo_password)
end

When /^I prepare the Additional Software upgrade process to fail$/ do
  # Remove the newest cowsay package from the APT cache with a DPKG hook
  # before it gets upgraded so that we simulate a failing upgrade.
  failing_dpkg_hook = <<~HOOK
    DPkg::Pre-Invoke {
      "ls -1 -v /var/cache/apt/archives/cowsay*.deb | tail -n 1 | xargs rm";
    };
  HOOK
  $vm.file_overwrite('/etc/apt/apt.conf.d/00failingDPKGhook', failing_dpkg_hook)
  # Tell the upgrade service check step not to run
  $vm.execute_successfully("touch #{ASP_STATE_DIR}/doomed_to_fail")
end

When /^I remove the "([^"]*)" deb files from the APT cache$/ do |package|
  $vm.execute_successfully(
    "rm /live/persistence/TailsData_unlocked/apt/cache/#{package}_*.deb"
  )
end

Then /^I can open the (.+) documentation from the notification$/ do |software|
  title = {
    'Additional Software' => 'Tails - Install by cloning',
    'Secure Boot'         => 'Tails - Secure Boot certificates update',
  }[software]
  click_gnome_shell_notification_button('Learn More')
  try_for(60) { @torbrowser = Dogtail::Application.new('Firefox') }
  step "\"#{title}\" has loaded in the Tor Browser"
end

Then /^the Additional Software dpkg hook has been run for package "([^"]*)" and notices the persistence is locked$/ do |package|
  asp_logs = "#{ASP_STATE_DIR}/log"
  assert(!$vm.file_empty?(asp_logs))
  try_for(180, delay: 2) do
    $vm.execute(
      "grep -E '^.*New\spackages\smanually\sinstalled:\s.*#{package}.*$' " \
      "#{asp_logs}"
    ).success?
  end
  try_for(60) do
    $vm.file_content(asp_logs)
       .include?('Warning: persistence storage is locked')
  end
end

When /^I can open the Additional Software configuration window from the notification$/ do
  click_gnome_shell_notification_button('Configure')
  Dogtail::Application.new('tails-additional-software-config')
end

Then /^I can open the Additional Software log file from the notification$/ do
  # Like in other step definitions in this file we would like to use
  # click_gnome_shell_notification_button() to click the 'Show Log'
  # button, but there's a race with other notifications that want to
  # be shown at this time so the notification we are looking for might
  # not be the one currently showing. So we work around that by
  # looking for the expected notification in the notification list.
  # (tails#21443)
  # Open GNOME Shell's notification list
  @screen.click(@screen.w / 2, 8)
  title = 'The installation of your additional software failed'
  notification = Dogtail::Application.new('gnome-shell')
                                     .children(roleName: 'notification')
                                     .find do |node|
    node.child?(title, roleName: 'label', retry: false)
  end
  # The first button of the notification is the one that expands it so
  # its action buttons are shown
  notification.children(roleName: 'button').first.click
  notification.button('Show Log').click
  # Close notification list, but for some reason clicking the same
  # coordinate again doesn't work
  @screen.click(@screen.w / 2, 9)
  try_for(60) do
    Dogtail::Application.new('gnome-text-editor').child(
      "log (#{ASP_STATE_DIR}) - Text Editor", roleName: 'frame'
    )
  end
end
