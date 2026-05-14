def boot_log
  $vm.execute_successfully('cat /var/log/boot.log').stdout
end

def looks_random?(data)
  chi_square = chi_squared(data)
  debug_log("Randomness check chi-square = #{chi_square}")
  # Based on https://gitlab.tails.boum.org/tails/blueprints/-/wikis/veracrypt/#detection
  chi_square.between?(136, 426)
end

def chi_squared(data)
  byte_counter = Array.new(256) { |i| data.bytes.count(i) }
  e = data.length / 256.0
  byte_counter.map { |n| (n - e)**2 }.sum / e
end

def bin_to_hex(data)
  data.unpack1('H*')
end

When /^I wait for the random seed to be updated$/ do
  try_for(60) do
    cmd = 'systemctl show --property=Result tails-update-random-seed-sector.service'
    output = $vm.execute_successfully(cmd).stdout.chomp
    assert_match(/^Result=success$/, output)
    sleep 1
  end
end

Then /^there is (a|no) random seed on USB drive "([^"]+)"$/ do |randomness, name|
  should_be_random = (randomness == 'a')

  disk = {
    path: $vm.storage.disk_path(name),
    opts: {
      format:   $vm.storage.disk_format(name),
      readonly: true,
    },
  }

  # Store the old random seed for comparison
  if @random_seed
    @old_random_seed = @random_seed
  end

  # Read the random seed from the USB drive
  offset = 512 * 34
  @random_seed = $vm.storage.guestfs_disk_helper(disk) do |g, disk_handle|
    g.pread_device(disk_handle, 512, offset)
  end
  assert_equal(512, @random_seed.length, 'Random seed is not 512 bytes long')
  # Print the random seed for debugging, formatted as a hex string
  debug_log("Random seed: #{bin_to_hex(@random_seed)}")

  # Check if the random seed is random
  looks_random = looks_random?(@random_seed)
  if should_be_random
    assert(looks_random, 'Randomness check failed')
  else
    assert(!looks_random, 'Randomness check succeeded but should have failed')
  end
end

Then(/^the random seed is different from the previous one$/) do
  assert_not_nil(@old_random_seed, 'No previous random seed found')
  assert_not_nil(@random_seed, 'No random seed found')
  assert(@old_random_seed != @random_seed,
         'Random seed is the same as the previous one')
end

Then(/^the random seed was written multiple times on first boot$/) do
  log = boot_log
  assert_match(/First boot, writing random seed \d+ times/, log)
  assert_match(/Wrote random seed \d+ times/, log)
end
