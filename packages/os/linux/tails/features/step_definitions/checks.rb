require 'ipaddr'

Then /^the included OpenPGP keys are valid for the next (\d+) months?$/ do |months|
  assert_all_keys_are_valid_for_n_months(:OpenPGP, Integer(months))
end

Then /^the keys trusted by APT are valid for the next (\d+) months$/ do |months|
  assert_all_keys_are_valid_for_n_months(:APT, Integer(months))
end

def assert_all_keys_are_valid_for_n_months(type, months)
  assert([:OpenPGP, :APT].include?(type))
  assert(months.is_a?(Integer))

  ignored_keys = []

  if type == :OpenPGP
    gpg_home = "/home/#{LIVE_USER}/.gnupg"
  else
    gpg_home = '/tmp/gnupg-new'
    $vm.execute_successfully(
      "install --directory --mode=0700 '#{gpg_home}'", user: LIVE_USER
    )
    apt_keyrings = $vm.file_glob('/usr/share/keyrings/debian-archive-*.pgp')
    apt_keyrings.reject! { |f| File.basename(f) == 'debian-archive-removed-keys.pgp' }
    $vm.execute_successfully(
      "gpg --homedir '#{gpg_home}' --import #{apt_keyrings.join(' ')}", user: LIVE_USER
    )
  end
  keys = $vm.execute_successfully(
    "gpg --homedir '#{gpg_home}' --batch --with-colons --fingerprint --list-key",
    user: LIVE_USER
  ).stdout
            .scan(/^fpr:::::::::([A-Z0-9]+):$/)
            .flatten
            .reject { |fpr| ignored_keys.include?(fpr) }

  invalid = keys.reject do |fpr|
    key_valid_for_n_months?(type, fpr, months, gpg_home)
  end
  assert(invalid.empty?,
         "The following #{type} key(s) will not be valid " \
         "in #{months} months: #{invalid.join(', ')}")
  assert_not_empty(keys, "No #{type} keys.")
end

def check_key_valid(line, months)
  # line comes from gpg --list-keys (don't use --with-colons)
  expiry = line.scan(/\[expire[ds]: ([0-9-]*)\]/)
  return true if expiry.empty?

  expiration_date = Date.parse(expiry.flatten.first)
  ((expiration_date << months.to_i) > DateTime.now)
end

def get_subkey_use(line)
  # useful to check if a subkey can be used for signing, for example
  # returns a string such as "SEA" (sign+encrypt+authenticate) or "S", etc.
  uses = line.scan(/\d\d\d\d-\d\d-\d\d \[([SEAC]+)\]/).flatten.first

  uses.split('').sort
end

def key_valid_for_n_months?(type, fingerprint, months, gpg_home)
  # we define a check to be valid:
  #  - only if the master key is valid
  #  - only if either:
  #    - there are no subkeys at all
  #    - at least one relevant subkey is valid
  #
  # any subkey is relevant if type == :OpenPGP
  # only signing keys are relevant if type == :APT
  #
  # Please note that this is not truly perfect: for example, if a OpenPGP key
  # has only its encryption subkey valid, but its signing subkey is expired,
  # this should give an error but will not.

  assert([:OpenPGP, :APT].include?(type))
  assert(months.is_a?(Integer))

  key_description = $vm.execute_successfully(
    "gpg --homedir '#{gpg_home}' --batch --list-options show-unusable-subkeys " \
    "--list-key #{fingerprint}",
    user: LIVE_USER
  ).stdout.split("\n")

  masterkey = key_description.grep(/^pub\b/)
  subkeys = key_description.grep(/^sub\b/)

  unless check_key_valid(masterkey.first, months)
    debug_log("Masterkey not valid: #{masterkey}")
    return false
  end

  return true if subkeys.empty?

  valid_subkeys = subkeys.filter do |subkey_line|
    if type == :APT && !get_subkey_use(subkey_line).include?('S')
      # we don't care about non-signing key
      false
    elsif check_key_valid(subkey_line, months)
      true
    else
      debug_log("subkey not valid: #{subkey_line}")
      false
    end
  end

  !valid_subkeys.empty?
end

Then /^the live user has been setup by live-boot$/ do
  assert_vmcommand_success(
    $vm.execute('test -e /var/lib/live/config/user-setup'),
    'live-boot failed its user-setup'
  )
  actual_username = $vm.execute('. /etc/live/config/username.conf; ' \
                                'echo $LIVE_USERNAME').stdout.chomp
  assert_equal(LIVE_USER, actual_username)
end

Then /^the live user is a member of only its own group and "(.*?)"$/ do |groups|
  expected_groups = groups.split(' ') << LIVE_USER
  actual_groups = $vm.execute("groups #{LIVE_USER}").stdout.chomp.sub(
    /^#{LIVE_USER} : /, ''
  ).split(' ')
  unexpected = actual_groups - expected_groups
  missing = expected_groups - actual_groups
  assert_equal(0, unexpected.size,
               "live user in unexpected groups #{unexpected}")
  assert_equal(0, missing.size,
               "live user not in expected groups #{missing}")
end

Then /^the (live|root) user owns its home directory which has strict permissions$/ do |name|
  case name
  when 'live'
    user = LIVE_USER
    home = "/home/#{user}"
  when 'root'
    user = 'root'
    home = '/root'
  end
  assert_vmcommand_success(
    $vm.execute("test -d #{home}"),
    "The #{name} user's home doesn't exist or is not a directory"
  )
  owner = $vm.execute("stat -c %U:%G #{home}").stdout.chomp
  perms = $vm.execute("stat -c %a #{home}").stdout.chomp
  assert_equal("#{user}:#{user}", owner)
  assert_equal('700', perms)
end

def listening_services
  $vm.execute_successfully('ss --no-header -ltupn')
     .stdout.chomp.split("\n").filter_map do |line|
    words = line.split(/[[:blank:]]+/)
    proto = words[0]
    next unless ['tcp', 'udp'].include?(proto)

    addr, port = words[4].split(':')
    users = words[6].match(
      /users:\(\("(?<proc>[^"]+)",pid=(?<pid>\d+),fd=(?<fd>\d+)\)\)/
    )
    {
      proto:,
      state: words[1],
      addr:  IPAddr.new(addr),
      port:  port.to_i,
      proc:  users[:proc],
      pid:   users[:pid].to_i,
      fd:    users[:fd].to_i,
    }
  end
end

Then /^no unexpected services are listening for network connections$/ do
  listening_services.each do |service|
    addr = service[:addr]
    port = service[:port]
    proc = service[:proc]
    next if addr.loopback?
    unless SERVICES_EXPECTED_ON_ALL_IFACES.include?([proc, addr, port])
      raise "Unexpected service '#{proc}' listening on #{addr}:#{port}"
    end

    puts "Service '#{proc}' is listening on #{addr}:#{port} " \
         'but has an exception'
  end
end

Then /^the live user can only access allowed local services$/ do
  uid = $vm.execute_successfully("id --user #{LIVE_USER}").stdout.chomp.to_i
  gid = $vm.execute_successfully("id --group #{LIVE_USER}").stdout.chomp.to_i
  listening_services.each do |service|
    proto = service[:proto]
    addr = service[:addr]
    port = service[:port]
    proc = service[:proc]
    proto.upcase!
    should_block = !SERVICES_ALLOWED_FOR_LIVE_USER.include?([addr, port])
    step "I open an untorified #{proto} connection to #{addr} on port #{port}"
    assert_equal(uid, @conn_uid)
    assert_equal(gid, @conn_gid)
    if should_block
      step 'the untorified connection fails'
    end
    dropped = firewall_has_dropped_packet_to?(
      addr.to_s, proto:, port:, uid: @conn_uid, gid: @conn_gid
    )
    assert_equal(
      should_block, dropped,
      "the firewall unexpectedly #{should_block ? 'failed to log' : 'logged'} a " \
      "dropped #{proto} packet to #{addr}:#{port}"
    )
    puts "#{LIVE_USER} could#{should_block ? ' not' : ''} access #{proc} on " \
         "#{addr}:#{port} (#{proto}) as expected"
  end
end

def expected_journal_error?(journal_entry)
  # Check if the journal entry matches all fields of any of the expected errors
  EXPECTED_JOURNAL_ENTRIES.any? do |expected_error|
    expected_error.all? do |field, pattern|
      if pattern.is_a?(Regexp)
        journal_entry[field] =~ pattern
      else
        journal_entry[field] == pattern
      end
    end
  end
end

Then /^there are no unexpected messages of priority "err" or higher in the journal$/ do
  output = $vm.execute_successfully(
    'journalctl --priority=3 --output=json --no-pager'
  ).stdout

  # Check if any of the journal entries are unexpected
  unexpected_errors = []
  output.split("\n").each do |line|
    journal_entry = JSON.parse(line)
    next if expected_journal_error?(journal_entry)

    # Sort the JSON to make the output more readable, put the MESSAGE
    # and SYSLOG_IDENTIFIER fields first
    sorted_entry = journal_entry.sort_by do |key, _value|
      [key == 'MESSAGE' ? 0 : 1, key == 'SYSLOG_IDENTIFIER' ? 0 : 1, key]
    end
    unexpected_errors << Hash[sorted_entry]
  end
  # Print the unexpected errors as a pretty JSON array if there are any
  assert(unexpected_errors.empty?,
         'Unexpected error messages in the journal: ' \
         "#{JSON.pretty_generate(unexpected_errors)}")
end

Given /^I plug and mount a USB drive containing a sample PNG$/ do
  @png_dir = share_host_files(Dir.glob("#{MISC_FILES_DIR}/*.png"))
end

def mat2_show(file_in_guest)
  $vm.execute_successfully("mat2 --show '#{file_in_guest}'",
                           user: LIVE_USER).stdout
end

Then /^MAT can clean some sample PNG file$/ do
  Dir.glob("#{MISC_FILES_DIR}/*.png").each do |png_on_host|
    png_name = File.basename(png_on_host)
    png_on_guest = "/home/#{LIVE_USER}/#{png_name}"
    cleaned_png_on_guest = "/home/#{LIVE_USER}/#{png_name}".sub(/[.]png$/,
                                                                '.cleaned.png')
    step "I copy \"#{@png_dir}/#{png_name}\" to \"#{png_on_guest}\" " \
         "as user \"#{LIVE_USER}\""
    raw_check_cmd = 'grep --quiet --fixed-strings --text ' \
                    "'Created with GIMP'"
    assert_vmcommand_success($vm.execute(raw_check_cmd + " '#{png_on_guest}'",
                                         user: LIVE_USER),
                             'The comment is not present in the PNG')
    check_before = mat2_show(png_on_guest)
    assert(check_before.include?("Metadata for #{png_on_guest}"),
           "MAT failed to see that '#{png_on_host}' is dirty")
    $vm.execute_successfully("mat2 '#{png_on_guest}'", user: LIVE_USER)
    check_after = mat2_show(cleaned_png_on_guest)
    assert(check_after.include?('No metadata found'),
           "MAT failed to clean '#{png_on_host}'")
    assert($vm.execute(raw_check_cmd + " '#{cleaned_png_on_guest}'",
                       user: LIVE_USER).failure?,
           'The comment is still present in the PNG')
    $vm.execute_successfully("rm '#{png_on_guest}'")
  end
end

def get_seccomp_status(process)
  assert($vm.process_running?(process), "Process #{process} not running.")
  pid = $vm.pidof(process)[0]
  status = $vm.file_content("/proc/#{pid}/status")
  status.match(/^Seccomp:\s+([0-9])/)[1].chomp.to_i
end

def get_apparmor_status(pid)
  apparmor_status = $vm.file_content("/proc/#{pid}/attr/current").chomp
  if apparmor_status.include?(')')
    # matches something like     /usr/sbin/cupsd (enforce)
    # and only returns what's in the parentheses
    apparmor_status.match(/[^\s]+\s+\((.+)\)$/)[1].chomp
  else
    apparmor_status
  end
end

Then /^Tor is (not )?confined with Seccomp$/ do |not_confined|
  expected_sandbox_status = not_confined.nil? ? 1 : 0
  sandbox_status = $vm.execute_successfully(
    '/usr/local/lib/tor_variable get --type=conf Sandbox'
  ).stdout.to_i
  sandbox_status_str = sandbox_status == 1 ? 'enabled' : 'disabled'
  assert_equal(expected_sandbox_status, sandbox_status,
               "Tor says that the sandbox is #{sandbox_status_str}")
  # tor's Seccomp status will always be 2 (filter mode), even with
  # "Sandbox 0", but let's still make sure that is the case.
  seccomp_status = get_seccomp_status('tor')
  assert_equal(2, seccomp_status,
               'Tor is not confined with Seccomp in filter mode')
end

Then /^the running process "(.+)" is confined with AppArmor in (complain|enforce) mode$/ do |process, mode|
  assert($vm.process_running?(process), "Process #{process} not running.")
  pid = $vm.pidof(process)[0]
  assert_equal(mode, get_apparmor_status(pid))
end

Then /^the Tor Status icon tells me that Tor is( not)? usable$/ do |not_usable|
  picture = not_usable ? 'TorStatusNotUsable' : 'TorStatusUsable'
  @screen.wait("#{picture}.png", 10)
end

def tor_connections_from_log
  $vm.execute(
    'journalctl -u tails-autotest-tor-circuits-log.service ' \
    '--no-pager --output=json --grep="Stream event for "',
    debug_log: false
  ).stdout.lines.reduce([]) do |messages, line|
    message = JSON.parse(line)
    messages << message['TOR_TARGET']
    messages
  rescue JSON::ParserError
    true
  end
end

def htpdate_pools_hosts
  $vm.file_content('/etc/default/htpdate.pools')
     .lines
     .select { |x| /^HTP_POOL_[123]=/.match(x) }
     .map { |line| /^HTP_POOL_[123]="(.*)"/.match(line).captures[0].split(',') }
     .flatten
end

def exclude_non_suspicious_connections(conns, expected_hosts: [])
  conns.reject do |addr|
    host = addr.split(':').first

    # Exclude connections which are ip-only: while those might be relevant, too, it's
    # hard to believe that unwanted connections (which are typically originating from
    # some application telemetry) won't have any valid hostname associated.
    begin
      IPAddr.new(host.split('.$').first)
      next true
    rescue IPAddr::InvalidAddressError
      # this means that the host is not an IP, which is what we actually want
    end

    # Reverse delegation
    next true if host.include?('.ip6.arpa') || host.include?('.in-addr.arpa')
    # Automatic upgrades
    next true if host == 'tails.net'
    # Exclude hosts which are part of the htpdate pool
    next true if htpdate_pools_hosts.include?(host)
    next true if expected_hosts.include?(host)

    false
  end
end
