Then(/^the firewall leak detector has detected leaks$/) do
  assert_raise(FirewallAssertionFailedError) do
    step 'all Internet traffic has only flowed through Tor'
  end
end

Given(/^I disable Tails' firewall$/) do
  $vm.execute('/usr/local/lib/do_not_ever_run_me')
  iptables = $vm.execute('iptables --wait 5 -L -n -v').stdout.chomp.split("\n")
  iptables.each do |line|
    next unless !line[/Chain (INPUT|OUTPUT|FORWARD) \(policy ACCEPT/] &&
                !line[/pkts[[:blank:]]+bytes[[:blank:]]+target/] &&
                !line.empty?

    raise "The Tails firewall was not successfully disabled:\n#{iptables}"
  end
end

When(/^I do a TCP DNS lookup of "(.*?)"$/) do |host|
  lookup = $vm.execute("host -T -t A #{host} #{SOME_DNS_SERVER}",
                       user: LIVE_USER)
  assert(lookup.success?, "Failed to resolve #{host}:\n#{lookup.stdout}")
end

When(/^I do a UDP DNS lookup of "(.*?)"$/) do |host|
  lookup = $vm.execute("host -t A #{host} #{SOME_DNS_SERVER}", user: LIVE_USER)
  assert(lookup.success?, "Failed to resolve #{host}:\n#{lookup.stdout}")
end

When(/^I send some ICMP pings$/) do
  # We ping an IP address to avoid a DNS lookup
  ping = $vm.execute("ping -c 5 #{SOME_DNS_SERVER}")
  assert(ping.success?, "Failed to ping #{SOME_DNS_SERVER}:\n#{ping.stderr}")
end
