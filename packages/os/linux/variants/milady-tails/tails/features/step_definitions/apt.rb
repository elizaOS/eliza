require 'uri'

def apt_sources
  $vm.execute_successfully(
    'cat /etc/apt/sources.list /etc/apt/sources.list.d/*'
  ).stdout
end

Then /^the only hosts in APT sources are "([^"]*)"$/ do |hosts_str|
  hosts = hosts_str.split(',')
  apt_sources.chomp.each_line do |line|
    next unless line.start_with? 'deb'

    source_host = URI(line.split[1]).host
    raise "Bad APT source '#{line}'" unless hosts.include?(source_host)
  end
end

Then /^no proposed-updates APT suite is enabled$/ do
  assert_no_match(/\s\S+-proposed-updates\s/, apt_sources)
end

Then /^no experimental APT suite is enabled for deb[.]torproject[.]org$/ do
  assert_no_match(
    /deb[.]torproject[.]org.*experimental/,
    apt_sources
  )
end

Then /^if releasing, the tagged Tails APT source is enabled$/ do
  unless git_on_a_tag
    puts 'Not on a tag ⇒ skipping this step'
    next
  end
  custom_apt_repo = 'deb.tails.boum.org'
  assert_match(
    %r{#{Regexp.quote(custom_apt_repo)}/?\s+#{Regexp.quote(git_current_tag)}\s},
    apt_sources
  )
end

Then /^if releasing, no unversioned Tails APT source is enabled$/ do
  unless git_on_a_tag
    puts 'Not on a tag ⇒ skipping this step'
    next
  end
  custom_apt_repo = 'deb.tails.boum.org'
  assert_no_match(
    %r{#{Regexp.quote(custom_apt_repo)}/?\s+(stable|testing|devel)\s},
    apt_sources
  )
end

When /^I update APT using apt$/ do
  recovery_proc = proc do
    ensure_process_is_terminated('apt')
    $vm.execute('rm -rf /var/lib/apt/lists/*')
  end
  retry_tor(recovery_proc) do
    Timeout.timeout(15 * 60) do
      $vm.execute_successfully("echo #{@sudo_password} | " \
                               'sudo -S apt --error-on=any update', user: LIVE_USER)
    end
  end
end

def wait_for_package_installation(package)
  try_for(2 * 60, delay: 3) do
    $vm.execute_successfully("dpkg -s '#{package}' 2>/dev/null " \
                             "| grep -qs '^Status:.*installed$'")
  end
end

Then /^I install "(.+)" using apt$/ do |package|
  recovery_proc = proc do
    ensure_process_is_terminated('apt')
    # We can't use execute_successfully here: the package might not be
    # installed at this point, and then "apt purge" would return non-zero.
    $vm.execute("apt purge #{package}")
  end
  retry_tor(recovery_proc) do
    Timeout.timeout(3 * 60) do
      $vm.spawn("echo #{@sudo_password} | " \
                "sudo -S DEBIAN_PRIORITY=critical apt -y install #{package}",
                user: LIVE_USER)
      wait_for_package_installation(package)
    end
  end
end

def wait_for_package_removal(package)
  try_for(3 * 60, delay: 3) do
    # Once purged, a package is removed from the installed package status
    # database and "dpkg -s" returns a non-zero exit code
    !$vm.execute("dpkg -s #{package}").success?
  end
end

Then /^I uninstall "(.+)" using apt$/ do |package|
  $vm.spawn("echo #{@sudo_password} | sudo -S apt -y purge #{package}", user: LIVE_USER)
  wait_for_package_removal(package)
end

When /^I configure APT to prefer an old version of cowsay$/ do
  apt_source = 'deb tor+http://deb.tails.boum.org/ asp-test-upgrade-cowsay main'
  $vm.file_overwrite('/etc/apt/sources.list.d/asp-test-upgrade-cowsay.list',
                     apt_source)
end

When /^I install an old version "([^"]*)" of the cowsay package using apt$/ do |version|
  step 'I update APT using apt'
  step 'I install "cowsay" using apt'
  step "the installed version of package \"cowsay\" is \"#{version}\""
end

When /^I revert the APT tweaks that made it prefer an old version of cowsay$/ do
  $vm.execute_successfully(
    'rm -f /etc/apt/sources.list.d/asp-test-upgrade-cowsay.list'
  )
end

When /^the installed version of package "([^"]*)" is( newer than)? "([^"]*)"( after Additional Software has been started)?$/ do |package, newer_than, version, asp|
  step 'the Additional Software installation service has started' if asp
  current_version = $vm.execute_successfully(
    "dpkg-query -W -f='${Version}' #{package}"
  ).stdout
  if newer_than
    cmd_helper("dpkg --compare-versions '#{version}' lt '#{current_version}'")
  else
    assert_equal(version, current_version)
  end
end

When /^I start Synaptic$/ do
  step 'I start "Synaptic Package Manager" via GNOME Activities Overview'
  deal_with_polkit_prompt(@sudo_password)
  @screen.wait('SynapticReload.png', 30)
end

When /^I update APT using Synaptic$/ do
  recovery_proc = proc do
    ensure_process_is_terminated('synaptic')
    step 'I start Synaptic'
  end
  retry_tor(recovery_proc) do
    @screen.click('SynapticReload.png')
    sleep 10 # It might take some time before APT starts downloading
    try_for(15 * 60, msg: 'Took too much time to download the APT data') do
      !$vm.process_running?('/usr/lib/apt/methods/tor+http')
    end
    synaptic = Dogtail::Application.new('synaptic', user: 'root')
    assert_raise(Dogtail::Failure) do
      synaptic.child(roleName: 'dialog', recursive: false)
              .child('Error', roleName: 'icon', retry: false)
    end
    unless $vm.process_running?('synaptic')
      raise 'Synaptic process vanished, did it segfault again?'
    end
  end
end

Then /^I install "(.+)" using Synaptic$/ do |package_name|
  assert_equal('cowsay', package_name,
               "We moved to images, so we don't support arbitrary package names." \
               ' See SynapticPackageName.png')
  recovery_proc = proc do
    ensure_process_is_terminated('synaptic')
    # We can't use execute_successfully here: the package might not be
    # installed at this point, and then "apt purge" would return non-zero.
    $vm.execute("apt -y purge #{package_name}")
    step 'I start Synaptic'
  end
  retry_tor(recovery_proc) do
    @screen.hide_cursor
    @screen.click('SynapticSearch.png')
    @screen.wait('SynapticDialogFind.png', 10)
    @screen.type(package_name)
    @screen.press('Return')
    @screen.wait('SynapticPackageName.png', 30).click
    @screen.press('Return')
    # Now we have marked the package for installation and we have to
    # wait for the Apply button to become available
    @screen.wait('SynapticListApply.png', 20).click
    @screen.wait('SynapticDialogApply.png', 10).click
    @screen.wait('SynapticClose.png', 4 * 60).click
    ensure_process_is_terminated('synaptic')
  end
end
