# In some steps below we allow some slack when verifying that the date
# was set appropriately because it may take time to send the `date`
# command over the remote shell and get the answer back, parsing and
# post-processing of the result, etc.
def max_time_drift
  15
end

When /^I set the system time to "([^"]+)"$/ do |time|
  $vm.execute_successfully("date -s '#{time}'")
  new_time = DateTime.parse($vm.execute_successfully('date').stdout).to_time
  expected_time_lower_bound = DateTime.parse(time).to_time
  expected_time_upper_bound = expected_time_lower_bound + max_time_drift
  assert(expected_time_lower_bound <= new_time &&
         new_time <= expected_time_upper_bound,
         "The guest's time was supposed to be set to " \
         "'#{expected_time_lower_bound}' but is '#{new_time}'")
end

When /^I bump the (hardware clock's|system) time with "([^"]+)"$/ do |clock_type, timediff|
  case clock_type
  when "hardware clock's"
    old_time = DateTime.parse(
      $vm.execute_successfully('hwclock -r').stdout
    ).to_time
    desired_new_time = cmd_helper(
      ['date', '--utc', '-d', "now #{timediff}", '+%Y-%m-%d %T']
    ).chomp
    $vm.execute_successfully("hwclock --set --date '#{desired_new_time}'")
    new_time = DateTime.parse(
      $vm.execute_successfully('hwclock -r').stdout
    ).to_time
  when 'system'
    old_time = DateTime.parse($vm.execute_successfully('date').stdout).to_time
    $vm.execute_successfully("date -s 'now #{timediff}'")
    new_time = DateTime.parse($vm.execute_successfully('date').stdout).to_time
  else
    raise ArgumentError, "unexpected clock type: #{clock_type}"
  end
  expected_time_lower_bound = DateTime.parse(
    cmd_helper(['date', '--rfc-3339=seconds', '-d', "#{old_time} #{timediff}"])
  ).to_time
  expected_time_upper_bound = expected_time_lower_bound + max_time_drift
  assert(expected_time_lower_bound <= new_time &&
         new_time <= expected_time_upper_bound,
         "The #{clock_type} time was supposed to be bumped to " \
         "'#{expected_time_lower_bound}' but is '#{new_time}'")
end

When /^I allow time sync before Tor connects to work again$/ do
  $vm.execute_successfully(
    'mv /etc/tails-get-network-time.conf.bak /etc/tails-get-network-time.conf'
  )
end

When /^I make sure time sync before Tor connects (fails|times out|indicates a captive portal|uses a fake connectivity check service)$/ do |failure_mode|
  if failure_mode == 'fails'
    url = 'http://localhost:666'
  else
    step 'a web server is running on the LAN'
    endpoint = case failure_mode
               when 'indicates a captive portal'
                 'redirect-to?url=/'
               when 'times out'
                 'delay/30'
               else
                 '/'
               end
    url = "#{@web_server_url}/#{endpoint}"
  end

  $vm.execute_successfully(
    'cp /etc/tails-get-network-time.conf /etc/tails-get-network-time.conf.bak'
  )
  $vm.file_overwrite(
    '/etc/tails-get-network-time.conf',
    ["url=#{url}", 'debug=true']
  )
end

def assert_time_diff_smaller_than(reference:, actual:,
                                  description:, max_diff_mins:)
  diff = (reference - actual).abs
  assert(diff < max_diff_mins.to_i * 60,
         "The #{description} clock is off by #{diff} seconds (#{actual})")
  debug_log "Time was #{diff} seconds off"
end

Then /^the system clock is less than (\d+) minutes incorrect$/ do |max_diff_mins|
  guest_time_str = $vm.execute_successfully('date --rfc-2822').stdout.chomp
  guest_time = Time.rfc2822(guest_time_str)
  assert_time_diff_smaller_than(
    reference:     Time.now,
    actual:        guest_time,
    description:   "guest's",
    max_diff_mins:
  )
end

def displayed_time_str
  Dogtail::Application.new('gnome-shell')
                      .child('\w+\s+\w+\s+\d+\s+\d+:\d+.*',
                             roleName: 'label')
                      .name
end

Then /^the displayed clock is less than (\d+) minutes incorrect in "([^"]*)"/ do |max_diff_mins, timezone_offset|
  displayed_time = DateTime.parse("#{displayed_time_str} #{timezone_offset}")
                           .to_time
  assert_time_diff_smaller_than(
    reference:     Time.now(in: timezone_offset),
    actual:        displayed_time,
    description:   'displayed',
    max_diff_mins:
  )
end

Then /^the system clock is just past Tails' source date$/ do
  system_time_str = $vm.execute_successfully('date').to_s
  system_time = DateTime.parse(system_time_str).to_time
  source_time_str = $vm.file_content('/etc/os-release')
                       .match(/^TAILS_SOURCE_DATE_EPOCH="([0-9]+)"$/)[1]
  source_time = Time.at(source_time_str.to_i)
  diff = system_time - source_time # => in seconds
  # Half an hour should be enough to boot Tails on any reasonable
  # hardware and VM setup.
  max_diff = 30 * 60
  assert(diff.positive?,
         "The system time (#{system_time}) is before the Tails " \
         "source date (#{source_time})")

  if diff > max_diff
    # In this case the only acceptable explanation is that systemd
    # adjusted the time, because its build time is more recent
    # than $SOURCE_DATE_EPOCH.
    systemd_has_adjusted_time = systemd_journal_includes?(
      '^System time advanced to built-in epoch: ',
      options: ['--dmesg'],
      matches: ['SYSLOG_IDENTIFIER=systemd', 'SYSLOG_PID=1'],
      regexp:  true
    )
    unless systemd_has_adjusted_time
      raise(
        "The system time (#{system_time}) is more than #{max_diff} seconds " \
        "past the source date (#{source_time}) and systemd was not involved"
      )
    end
  end
end

Then /^Tails' hardware clock is close to the host system's time$/ do
  host_time = Time.now
  hwclock_time_str = $vm.execute('hwclock -r').stdout.chomp
  hwclock_time = DateTime.parse(hwclock_time_str).to_time
  diff = (hwclock_time - host_time).abs
  assert(diff <= max_time_drift)
end

Then /^the hardware clock is still off by "([^"]+)"$/ do |timediff|
  hwclock = DateTime.parse(
    $vm.execute_successfully('hwclock -r').stdout.chomp
  ).to_time
  expected = DateTime.parse(cmd_helper(['date', '--rfc-3339=seconds',
                                        '-d', "now #{timediff}",])).to_time
  expected_time_lower_bound = expected - max_time_drift
  expected_time_upper_bound = expected + 1
  assert(expected_time_lower_bound <= hwclock &&
         hwclock <= expected_time_upper_bound,
         'The hardware clock of the Tails VM should be between ' \
         "'#{expected_time_lower_bound}' and '#{expected_time_upper_bound}', " \
         "but is actually '#{hwclock}'")
end

Then /^I make NetworkManager perform a connectivity check$/ do
  $vm.file_overwrite(
    '/etc/NetworkManager/conf.d/connectivity.conf',
    [
      '[connectivity]',
      "uri=#{@web_server_url}/concheck",
      'response=OK',
      '[logging]',
      'level=DEBUG',
      'domains=CORE,CONCHECK',
    ]
  )

  # Get the journal cursor of the latest NetworkManager log line.
  cursor_line = $vm.execute_successfully(
    'journalctl -u NetworkManager.service -e -n1 --show-cursor | tail -n1'
  ).stdout.chomp
  cursor = cursor_line.match(/-- cursor: (.*)/)[1]

  # Restart NetworkManager to make it use the new config and perform a
  # connectivity check.
  $vm.execute_successfully('systemctl restart NetworkManager.service')

  # Wait until the connectivity check has been performed.
  try_for(20) do
    output = $vm.execute_successfully(
      "journalctl -u NetworkManager.service --show-cursor --after-cursor '#{cursor}'"
    ).stdout.chomp
    assert(!output.empty?)
    cursor = output.match(/-- cursor: (.*)/)[1]
    # Return true if any line contains 'manager: connectivity checking indicates'
    output.lines.any? { |l| l.include?('manager: connectivity checking indicates') }
  end
end

Then /^the fake connectivity check service has received a new HTTP request$/ do\
  @captured_request_headers ||= []
  headers = []
  try_for(
    10,
    msg: 'The fake connectivity check service has not received a new HTTP request'
  ) do
    # List the files in the fake connectivity check service's headers
    headers = Dir.glob("#{@lan_web_server_headers_dir}/*")

    # Check that there are more headers than before
    headers.size > @captured_request_headers.size
  end

  # Append the new headers to the list of captured headers
  @captured_request_headers += headers
end

Then /^the HTTP requests received by the fake connectivity check service are identical$/ do
  # We can only compare headers if there are at least two of them
  assert(@captured_request_headers.size >= 2,
         'There are not enough HTTP requests received by the fake connectivity ' \
          'check service to compare them')
  first_header = @captured_request_headers[0]

  # Check that all headers are identical to the first one by executing
  # `diff --unified=0 --from-file #{first_header} #{@lan_web_server_headers_dir}/*`
  # on the host.
  diff = cmd_helper([
                      'diff',
                      '--unified=0',
                      '--from-file', first_header,
                      *@captured_request_headers,
                    ])
  assert(diff.empty?,
         'The HTTP requests received by the fake connectivity check service ' \
         "are not identical:\n#{diff}")
end
