Given /^I create an? ([[:alnum:]]+) swap partition on disk "([^"]+)"$/ do |parttype, name|
  $vm.storage.disk_mkswap(name, parttype)
end

Then /^an? "([^"]+)" partition was detected by Tails on drive "([^"]+)"$/ do |type, name|
  part_info = $vm.execute_successfully(
    "blkid '#{$vm.disk_dev(name)}'"
  ).stdout.strip
  assert(part_info.split.grep(/^TYPE="#{Regexp.escape(type)}"$/),
         "No #{type} partition was detected by Tails on disk '#{name}'")
end

Then /^Tails has no disk swap enabled$/ do
  # Skip first line which contain column headers and skip lines which
  # contain a zram device
  swap_info = $vm.execute_successfully(
    'grep -v ^/dev/zram < /proc/swaps | tail -n+2'
  ).stdout
  assert(swap_info.empty?,
         "Disk swapping is enabled according to /proc/swaps:\n#{swap_info}")
end

Given /^I create an?( (\d+) ([[:alpha:]]+))? ([[:alnum:]]+) partition( labeled "([^"]+)")? with an? ([[:alnum:]]+) filesystem( encrypted with password "([^"]+)")? on disk "([^"]+)"$/ do |with_size, size, unit, parttype, has_label, label, fstype, is_encrypted, luks_password, name| # rubocop:disable Metrics/ParameterLists
  opts = {}
  opts.merge!(label:) if has_label
  opts.merge!(luks_password:) if is_encrypted
  opts.merge!(size:) if with_size
  opts.merge!(unit:) if with_size
  $vm.storage.disk_mkpartfs(name, parttype, fstype, **opts)
end

Then /^drive "([^"]+)" is not mounted$/ do |name|
  dev = $vm.disk_dev(name)
  assert($vm.execute("grep -qs '^#{dev}' /proc/mounts").failure?,
         "an untrusted partition from drive '#{name}' was automounted")
end

Then /^Tails Greeter has( not)? detected a persistence partition$/ do |no_persistence|
  expecting_persistence = no_persistence.nil?
  assert !greeter.nil?
  found_persistence = greeter
                      .child?('Unlock', roleName: 'button')
  assert_equal(expecting_persistence, found_persistence,
               "Persistence is unexpectedly#{no_persistence} enabled")
end
