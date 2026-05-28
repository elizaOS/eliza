def udev_watchdog_monitored_device
  ps_output = $vm.execute_successfully('ps -wweo cmd').stdout
  udev_watchdog_cmd = '/usr/local/sbin/udev-watchdog'

  # The regex below looks for a line like the following:
  # /usr/local/sbin/udev-watchdog \
  #     /devices/pci0000:00/0000:00:01.1/ata2/host1/target1:0:0/1:0:0:0/block/sr0 \
  #     cd
  # We're only interested in the device itself, not in the type
  ps_output_scan = ps_output.scan(
    /^#{Regexp.escape(udev_watchdog_cmd)}\s(\S+)\s(?:cd|disk)$/
  )
  assert_equal(1, ps_output_scan.count,
               'There should be one udev-watchdog running.')
  monitored_out = ps_output_scan.flatten[0]
  assert_not_nil(monitored_out)
  monitored_device_id = $vm.file_content("/sys#{monitored_out}/dev").chomp
  $vm.execute_successfully(
    "readlink -f /dev/block/'#{monitored_device_id}'"
  ).stdout.chomp
end

Given /^udev-watchdog is monitoring the correct device$/ do
  assert_equal(boot_device, udev_watchdog_monitored_device)
end

def used_ram_in_MiB
  $vm.execute_successfully("free -m | awk '/^Mem:/ { print $3 }'")
     .stdout.chomp.to_i
end

def detected_ram_in_MiB
  $vm.execute_successfully("free -m | awk '/^Mem:/ { print $2 }'")
     .stdout.chomp.to_i
end

def pattern_coverage_in_guest_ram(reference_memory_b)
  assert_not_nil(reference_memory_b)
  reference_memory_m = convert_to_MiB(reference_memory_b, 'b')
  dump = "#{$config['TMPDIR']}/memdump"
  # Workaround: when dumping the guest's memory via core_dump(), libvirt
  # will create files that only root can read. We therefore pre-create
  # them with more permissible permissions, which libvirt will preserve
  # (although it will change ownership) so that the user running the
  # script can grep the dump for the fillram pattern, and delete it.
  File.delete(dump) if File.exist?(dump)
  FileUtils.touch(dump)
  FileUtils.chmod(0o666, dump)
  $vm.domain.core_dump(dump)
  # Make sure to close after reading stdout, to avoid Zombies:
  grep = IO.popen(['grep', '--text', '-c', 'wipe_didnt_work', dump])
  patterns = grep.gets.to_i
  grep.close
  File.delete dump
  # Pattern is 16 bytes long
  patterns_b = patterns * 16
  coverage = patterns_b.to_f / reference_memory_b
  puts format('Pattern coverage: %.3<coverage>f%% (%<patterns_m>s MiB ' \
              'out of %<reference_memory_m>s MiB reference memory)',
              coverage:           coverage * 100,
              patterns_m:         convert_to_MiB(patterns_b, 'b'),
              reference_memory_m:)
  coverage
end

Given /^I prepare Tails for memory erasure tests$/ do
  # Have our initramfs-pre-shutdown-hook sleep for a while
  $vm.execute_successfully('touch /run/initramfs/tails_shutdown_debugging')

  # We exclude the memory we reserve for the kernel and admin
  # processes above from the free memory since fillram will be run by
  # an unprivileged user in user-space.
  detected_ram_m = detected_ram_in_MiB
  used_mem_before_fill_m = used_ram_in_MiB
  free_mem_before_fill_m = detected_ram_m - used_mem_before_fill_m
  @free_mem_before_fill_b = convert_to_bytes(free_mem_before_fill_m, 'MiB')

  ['initramfs-shutdown', 'memlockd',
   'tails-shutdown-on-media-removal',].each do |srv|
    $vm.execute_successfully("systemctl status #{srv}.service")
  end
end

When /^I start a process allocating (\d+) ([[:alpha:]]+) of memory with a known pattern$/ do |size, unit|
  fillram_script_path = '/tmp/fillram'
  @fillram_cmd = "python3 #{fillram_script_path}"
  fillram_done_path = "#{fillram_script_path}_done"
  fillram_script = <<~FILLRAM
    import math
    import time
    pattern = "wipe_didnt_work\\n"
    buffer = pattern * math.ceil(#{convert_to_bytes(size.to_i, unit)} / len(pattern))
    with open("#{fillram_done_path}", "w") as f:
      f.write("done")
    time.sleep(365*24*60*60)
    print(buffer)
  FILLRAM
  $vm.file_overwrite(fillram_script_path, fillram_script)
  $vm.spawn(@fillram_cmd)
  try_for(60) { $vm.file_exist?(fillram_done_path) }
end

When /^I kill the allocating process$/ do
  $vm.execute_successfully("pkill --full '^#{@fillram_cmd}'")
  try_for(10) do
    $vm.execute("pgrep --full '^#{@fillram_cmd}'").failure?
  end
end

def avail_space_in_mountpoint(mountpoint)
  $vm.execute_successfully(
    "df --block-size=1 --output=avail '#{mountpoint}'"
  ).stdout.split("\n")[1].to_i
end

def assert_filesystem_is_full(mountpoint)
  avail_space = avail_space_in_mountpoint(mountpoint)
  assert_equal(
    0, avail_space,
    "#{avail_space} bytes are still free on #{mountpoint}," \
    'while this filesystem was expected to be full'
  )
end

# Fill file at path with pattern (+ newline) until the device is
# full. If `iterations` is given then the pattern (+ newline) is
# written exactly that many times (also it is much slower).
def fill_file(path:, pattern: 'wipe_didnt_work', iterations: nil)
  # We use `yes(1)` because it is extremely fast. Piping into `dd`
  # when iterations is not set might seem pointless but `yes` aborts
  # before the device is completely full for some reason while `dd`
  # doesn't, so this ensures that we truly fill the device.
  cmd = "yes #{pattern} | dd of=#{path}"
  if iterations
    # The "+ 1" is for the newline added by `yes`
    cmd += " bs=#{pattern.size + 1} count=#{iterations}"
  end
  p = $vm.execute(cmd)
  $vm.execute_successfully('sync')
  if iterations
    assert_vmcommand_success(p)
  else
    assert_equal(1, p.returncode)
    assert(p.stderr['No space left on device'])
    assert_filesystem_is_full(path)
  end
end

When /^I mount a (\d+) MiB tmpfs on "([^"]+)" and fill it with a known pattern$/ do |size_MiB, mountpoint|
  size_MiB = size_MiB.to_i
  @tmp_filesystem_size_b = convert_to_bytes(size_MiB, 'MiB')
  $vm.execute_successfully(
    "mount -t tmpfs -o 'size=#{size_MiB}M' tmpfs '#{mountpoint}'"
  )
  fill_file(path: "#{mountpoint}/file")
end

When(/^I fill the USB drive with a known pattern$/) do
  fill_file(path: "#{@tmp_usb_drive_mount_dir}/file")
end

When(/^I read the content of the test FS$/) do
  $vm.execute_successfully("cat #{@tmp_usb_drive_mount_dir}/file >/dev/null")
end

Then /^patterns cover at least (\d+)% of the test FS size in the guest's memory$/ do |expected_coverage|
  reference_memory_b = @tmp_filesystem_size_b
  coverage = pattern_coverage_in_guest_ram(reference_memory_b)
  min_coverage = expected_coverage.to_f / 100
  assert(coverage > min_coverage,
         format('%.3<coverage>f%% of the test FS size ' \
                '(%<tmp_filesystem_size_MiB>s MiB) ' \
                'has the pattern, but more than %.3<min_coverage>f%% ' \
                'was expected',
                coverage:                coverage * 100,
                tmp_filesystem_size_MiB: convert_from_bytes(
                  @tmp_filesystem_size_b, 'MiB'
                ),
                min_coverage:            min_coverage * 100))
end

Then /^patterns cover at least (\d+) MiB in the guest's memory$/ do |expected_patterns_MiB|
  reference_memory_b = convert_to_bytes(expected_patterns_MiB.to_i, 'MiB')
  coverage = pattern_coverage_in_guest_ram(reference_memory_b)
  min_coverage = 1
  assert(coverage >= min_coverage,
         format('%.3<coverage>f%% of the expected size ' \
                '(%<expected_patterns_MiB>s MiB) ' \
                'has the pattern, but more than %.3<min_coverage>f%% ' \
                'was expected',
                coverage:              coverage * 100,
                expected_patterns_MiB:,
                min_coverage:          min_coverage * 100))
end

Then /^patterns cover less than (\d+) MiB in the guest's memory$/ do |expected_patterns_MiB|
  reference_memory_b = convert_to_bytes(expected_patterns_MiB.to_i, 'MiB')
  coverage = pattern_coverage_in_guest_ram(reference_memory_b)
  max_coverage = 1
  assert(coverage < max_coverage,
         format('%.3<coverage>f%% of the expected size ' \
                '(%<expected_patterns_MiB>s MiB) ' \
                'has the pattern, but less than %.3<max_coverage>f%% ' \
                'was expected',
                coverage:              coverage * 100,
                expected_patterns_MiB:,
                max_coverage:          max_coverage * 100))
end

When(/^I umount "([^"]*)"$/) do |mount_arg|
  $vm.execute_successfully("umount '#{mount_arg}'")
end

Then /^I find very few patterns in the guest's memory(?: after (\d+) seconds)?$/ do |delay|
  # Give the Linux kernel's memory poisoning feature time to do its
  # job. This is not needed in scenarios that first run "I wait for
  # Tails to finish wiping the memory step", such as those in
  # emergency_shutdown.feature.
  sleep delay.to_i if delay
  coverage = pattern_coverage_in_guest_ram(@free_mem_before_fill_b)
  max_coverage = 0.008
  assert(
    coverage < max_coverage,
    format('%.3<coverage>f%% of the free memory still has the ' \
           'pattern, but less than %.3<max_coverage>f%% was expected',
           coverage:     coverage * 100,
           max_coverage: max_coverage * 100)
  )
end

When /^I wait for Tails to finish wiping the memory$/ do
  @screen.wait('MemoryWipeCompleted.png', 90)
end

When /^I fill a (\d+) MiB file with a known pattern on the (persistent|root) filesystem$/ do |size_MiB, fs|
  pattern = "wipe_didnt_work\n"
  pattern_nb = (convert_to_bytes(size_MiB.to_i, 'MiB') / pattern.size).floor
  case fs
  when 'root'
    dest_file = "/#{random_alpha_string(10)}"
  when 'persistent'
    dest_file = "/home/amnesia/Persistent/#{random_alpha_string(10)}"
  else
    raise 'This should not happen'
  end
  # `fill_file` prints its own newline after each `pattern`, so we have to skip it in
  # `pattern` below.
  fill_file(path: dest_file, pattern: pattern[0..-2], iterations: pattern_nb)
end

When(/^I drop all kernel caches$/) do
  $vm.execute_successfully('echo 3 > /proc/sys/vm/drop_caches')
end

When(/^I trigger shutdown$/) do
  $vm.spawn('halt')
end
