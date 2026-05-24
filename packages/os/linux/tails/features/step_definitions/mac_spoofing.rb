class MacSpoofingError < StandardError
end

def all_ethernet_nics
  $vm.execute_successfully(
    'get_all_ethernet_nics', libs: 'hardware'
  ).stdout.split
end

When /^I disable MAC spoofing in Tails Greeter$/ do
  dialog = open_greeter_additional_settings
  dialog.child('MAC Address Anonymization', roleName: 'label').click
  dialog.child("Don't anonymize MAC addresses", roleName: 'label').click
  dialog.child('Add', roleName: 'button').click
  wait_for_welcome_screen_settings_to_vanish
end

Then /^the (\d+)(?:st|nd|rd|th) network device has (its real|a spoofed) MAC address configured$/ do |dev_nr, mode|
  is_spoofed = (mode == 'a spoofed')
  alias_name = "net#{dev_nr.to_i - 1}"
  nic_real_mac = $vm.real_mac(alias_name)
  nic = "eth#{dev_nr.to_i - 1}"
  nic_current_mac = $vm.execute_successfully(
    "get_current_mac_of_nic #{nic}", libs: 'hardware'
  ).stdout.chomp
  begin
    if is_spoofed
      if nic_real_mac == nic_current_mac
        raise MacSpoofingError,
              "The MAC address was expected to be spoofed but wasn't"
      end
    elsif nic_real_mac != nic_current_mac
      raise MacSpoofingError,
            'The MAC address is spoofed but was expected to not be'
    end
  rescue MacSpoofingError => e
    save_failure_artifact('Network capture', @sniffer.pcap_file)
    raise e
  end
end

Then /^no network device leaked the real MAC address$/ do
  macs = $vm.all_real_macs
  assert_all_connections(@sniffer.pcap_file) do |c|
    macs.all? do |mac|
      ![c.mac_saddr, c.mac_daddr].include?(mac)
    end
  end
end

Then /^some network device leaked the real MAC address$/ do
  assert_raise(FirewallAssertionFailedError) do
    step 'no network device leaked the real MAC address'
  end
end

Given /^macchanger will fail by not spoofing and always returns (\S+)$/ do |mode|
  $vm.execute_successfully('mv /usr/bin/macchanger /usr/bin/macchanger.orig')
  $vm.execute_successfully("ln -s /bin/#{mode} /usr/bin/macchanger")
end

Given /^no network interface modules can be unloaded$/ do
  # Note that the real /sbin/modprobe is a symlink to /bin/kmod, and
  # for it to run in modprobe compatibility mode the name must be
  # exactly "modprobe", so we just move it somewhere our of the path
  # instead of renaming it ".real" or whatever we usuablly do when
  # diverting executables for wrappers.
  modprobe_divert = '/usr/local/lib/modprobe'
  $vm.execute_successfully(
    "dpkg-divert --add --rename --divert '#{modprobe_divert}' /sbin/modprobe"
  )
  fake_modprobe_wrapper = <<~WRAPPER
    #!/bin/sh
    if echo "${@}" | grep -q -- -r; then
        exit 1
    fi
    exec '#{modprobe_divert}' "${@}"
  WRAPPER
  $vm.file_append('/sbin/modprobe', fake_modprobe_wrapper)
  $vm.execute_successfully('chmod a+rx /sbin/modprobe')
end

Then /^(\d+|no) network interface(?:s)? (?:is|are) enabled$/ do |expected_nr_nics|
  # NOTE: "no".to_i => 0 in Ruby.
  expected_nr_nics = expected_nr_nics.to_i
  nr_nics = all_ethernet_nics.size
  assert_equal(expected_nr_nics, nr_nics)
end

Then /^the MAC spoofing panic mode disabled networking$/ do
  nm_state = $vm.execute_successfully('systemctl show NetworkManager').stdout
  nm_is_disabled = $vm.pidof('NetworkManager').empty? &&
                   nm_state[/^LoadState=masked$/] &&
                   nm_state[/^ActiveState=inactive$/]
  assert(nm_is_disabled, 'NetworkManager was not disabled')
  all_ethernet_nics.each do |nic|
    ['nic_ipv4_addr', 'nic_ipv6_addr'].each do |function|
      addr = $vm.execute_successfully(
        "#{function} #{nic}", libs: 'hardware'
      ).stdout.chomp
      assert_equal('', addr, "NIC #{nic} was assigned address #{addr}")
    end
  end
end

When /^I hotplug a network device( and wait for it to be initialized)?$/ do |wait|
  initial_nr_nics = wait ? all_ethernet_nics.size : nil
  device = 'pcnet'
  debug_log("Hotplugging a '#{device}' network device")
  xml = <<-XML
    <interface type='network'>
      <alias name='net1'/>
      <mac address='52:54:00:11:22:33'/>
      <source network='TailsToasterNet'/>
      <model type='#{device}'/>
      <link state='up'/>
    </interface>
  XML
  $vm.plug_device(xml)
  if wait
    try_for(30) do
      all_ethernet_nics.size >= initial_nr_nics + 1
    end
  end
end
