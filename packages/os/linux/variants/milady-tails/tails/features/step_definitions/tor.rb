require 'json'

def iptables_chains_parse(iptables, table = 'filter')
  assert(block_given?)
  cmd = "#{iptables}-save -c -t #{table} | iptables-xml"
  xml_str = $vm.execute_successfully(cmd).stdout
  rexml = REXML::Document.new(xml_str)
  rexml.get_elements('iptables-rules/table/chain').each do |element|
    yield(
      element.attribute('name').to_s,
      element.attribute('policy').to_s,
      element.get_elements('rule')
    )
  end
end

def ip4tables_chains(table = 'filter', &block)
  iptables_chains_parse('iptables', table, &block)
end

def ip6tables_chains(table = 'filter', &block)
  iptables_chains_parse('ip6tables', table, &block)
end

def iptables_rules_parse(iptables, chain, table)
  iptables_chains_parse(iptables, table) do |name, _, rules|
    return rules if name == chain
  end
  nil
end

def iptables_rules(chain, table = 'filter')
  iptables_rules_parse('iptables', chain, table)
end

def ip6tables_rules(chain, table = 'filter')
  iptables_rules_parse('ip6tables', chain, table)
end

def ip4tables_packet_counter_sum(chain, iface, table = 'filter')
  cmd = "iptables --wait 5 -t #{table} -L #{chain} -v " \
        "| grep 'ACCEPT.*#{iface}' | awk '{ print $1 }'"
  output = $vm.execute_successfully(cmd).stdout
  incoming_packets, outgoing_packets = output.split(/\n/)
  Integer(incoming_packets) + Integer(outgoing_packets)
end

def iptables_filter_add(add, target, address, port)
  manipulate = add ? 'I' : 'D'
  command = "iptables --wait 5 -#{manipulate} OUTPUT " \
    '-p tcp ' \
    "--destination #{address} " \
    "--destination-port #{port} " \
    "-j #{target}"
  $vm.execute_successfully(command)
  command
end

def try_xml_element_text(element, xpath, default = nil)
  node = element.elements[xpath]
  node.nil? || !node.has_text? ? default : node.text
end

Then /^the firewall's policy is to (.+) all IPv4 traffic$/ do |expected_policy|
  expected_policy.upcase!
  ip4tables_chains do |name, policy, _|
    if ['INPUT', 'FORWARD', 'OUTPUT'].include?(name)
      assert_equal(expected_policy, policy,
                   "Chain #{name} has unexpected policy #{policy}")
    end
  end
end

Then /^the firewall is configured to only allow the (.+) users? to connect directly to the Internet over IPv4$/ do |users_str|
  users = users_str.split(/, | and /)
  expected_uids = Set.new
  users.each do |user|
    expected_uids << $vm.execute_successfully("id -u #{user}").stdout.to_i
  end
  allowed_output = iptables_rules('OUTPUT').select do |rule|
    out_iface = rule.elements['conditions/match/o']
    is_maybe_accepted = rule.get_elements('actions/*').find do |action|
      !['DROP', 'REJECT', 'LOG'].include?(action.name)
    end
    is_maybe_accepted &&
      (
        # nil => match all interfaces according to iptables-xml
        out_iface.nil? ||
        ((out_iface.text == 'lo') \
         == \
         (out_iface.attribute('invert').to_s == '1'))
      )
  end
  uids = Set.new
  allowed_output.each do |rule|
    rule.elements.each('actions/*') do |action|
      destination = try_xml_element_text(rule, 'conditions/match/d')
      if action.name == 'ACCEPT'
        # nil == 0.0.0.0/0 according to iptables-xml
        assert(destination == '0.0.0.0/0' || destination.nil?,
               "The following rule has an unexpected destination:\n#{rule}")
        state_cond = try_xml_element_text(rule, 'conditions/state/state')
        next if state_cond == 'ESTABLISHED'

        assert_not_nil(rule.elements['conditions/owner/uid-owner'])
        rule.elements.each('conditions/owner/uid-owner') do |owner|
          uid = owner.text.to_i
          uids << uid
          assert(expected_uids.include?(uid),
                 "The following rule allows uid #{uid} to access the " \
                 "network, but we only expect uids #{expected_uids.to_a} " \
                 "(#{users_str}) to have such access:\n#{rule}")
        end
      elsif action.name == 'call' && action.elements[1].name == 'lan'
        lan_subnets = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']
        assert(lan_subnets.include?(destination),
               "The following lan-targeted rule's destination is " \
               "#{destination} which may not be a private subnet:\n" +
               rule.to_s)
      elsif action.name == 'call' && action.elements[1].name == 'log_reject'
        next
      else
        raise "Unexpected iptables OUTPUT chain rule:\n#{rule}"
      end
    end
  end
  uids_not_found = expected_uids - uids
  assert(uids_not_found.empty?,
         "Couldn't find rules allowing uids #{uids_not_found.to_a} " \
         'access to the network')
end

Then /^the firewall's NAT rules only redirect traffic for the Unsafe Browser, Tor's TransPort, and DNSPort$/ do
  loopback_address = '127.0.0.1/32'
  tor_onion_addr_space = '127.192.0.0/10'
  tor_trans_port = '9040'
  dns_port = '53'
  tor_dns_port = '5353'
  ip4tables_chains('nat') do |name, _, rules|
    case name
    when 'OUTPUT'
      good_rules = rules.select do |rule|
        redirect = rule.get_elements('actions/*').all? do |action|
          action.name == 'REDIRECT'
        end
        destination = try_xml_element_text(rule, 'conditions/match/d')
        redir_port = try_xml_element_text(rule, 'actions/REDIRECT/to-ports')
        redirected_to_trans_port = redir_port == tor_trans_port
        udp_destination_port = try_xml_element_text(rule,
                                                    'conditions/udp/dport')
        dns_redirected_to_tor_dns_port = (udp_destination_port == dns_port) &&
                                         (redir_port == tor_dns_port)
        redirect &&
          (
           (destination == tor_onion_addr_space && redirected_to_trans_port) ||
           (destination == loopback_address && dns_redirected_to_tor_dns_port)
         )
      end
      bad_rules = rules - good_rules
      assert(bad_rules.empty?,
             "The NAT table's OUTPUT chain contains some unexpected " \
             "rules:\n#{bad_rules}")
    when 'POSTROUTING'
      assert_equal(1, rules.size)
      rule = rules.first
      source = try_xml_element_text(rule, 'conditions/match/s')
      # This is the IP address of veth-clearnet, the interface used in
      # the clearnet network namespace that grants the Unsafe Browser
      # full access to the Internet.
      assert_equal('10.200.1.16/30', source)
      actions = rule.get_elements('actions/*')
      assert_equal(1, actions.size)
      assert_equal('MASQUERADE', actions.first.name)
    else
      assert(rules.empty?,
             "The NAT table contains unexpected rules for the #{name} " \
             "chain:\n#{rules}")
    end
  end
end

Then /^the firewall is configured to block all external IPv6 traffic$/ do
  ip6_loopback = '::1/128'
  expected_policy = 'DROP'
  ip6tables_chains do |name, policy, rules|
    assert_equal(expected_policy, policy,
                 "The IPv6 #{name} chain has policy #{policy} but we " \
                 "expected #{expected_policy}")
    good_rules = rules.select do |rule|
      ['DROP', 'REJECT', 'LOG'].any? do |target|
        rule.elements["actions/#{target}"]
      end \
      ||
        ['s', 'd'].all? do |x|
          try_xml_element_text(rule, "conditions/match/#{x}") == ip6_loopback
        end
    end
    bad_rules = rules - good_rules
    assert(bad_rules.empty?,
           "The IPv6 table's #{name} chain contains some unexpected rules:\n" +
           bad_rules.map(&:to_s).join("\n"))
  end
end

def firewall_has_dropped_packet_to?(host, proto: nil, port: nil, uid: nil, gid: nil)
  regex = ['^Dropped outbound packet:']
  regex << "DST=#{Regexp.escape(host)}"
  regex << "PROTO=#{Regexp.escape(proto.upcase)}" if proto
  regex << "DPT=#{port}" if port
  regex << "UID=#{uid}" if uid
  regex << "GID=#{gid}" if gid
  regex = regex.join('\s(?:.*\s)?')
  systemd_journal_includes?(regex, regexp: true)
end

When /^I open an untorified (TCP|UDP|ICMP) connection to (\S*)(?: on port (\d+))?$/ do |proto, host, port|
  port_suffix = port.nil? ? '' : ":#{port}"
  @conn_proto = proto
  @conn_host = host
  @conn_port = port
  case proto
  when 'TCP'
    assert_not_nil(port)
    cmd = "nc.traditional -v -z #{host} #{port}"
    user = LIVE_USER
  when 'UDP'
    assert_not_nil(port)
    cmd = "nc.traditional -v -z -u #{host} #{port}"
    user = LIVE_USER
  when 'ICMP'
    cmd = "ping -c 5 #{host}"
    user = 'root'
  end
  @conn_uid = $vm.execute_successfully("id --user #{user}").stdout.chomp.to_i
  @conn_gid = $vm.execute_successfully("id --group #{user}").stdout.chomp.to_i
  assert(
    !firewall_has_dropped_packet_to?(
      host, proto:, port:, uid: @conn_uid, gid: @conn_gid
    ),
    "Anti-test failed: A #{proto} packet to #{host}#{port_suffix} has already " \
    'been dropped by the firewall'
  )
  @conn_res = $vm.execute(cmd, user:)
end

Then /^the untorified connection fails$/ do
  case @conn_proto
  when 'TCP', 'UDP'
    expected_in_stderr = 'Connection refused'
    conn_failed = !@conn_res.success? &&
                  @conn_res.stderr.chomp.end_with?(expected_in_stderr)
  when 'ICMP'
    conn_failed = !@conn_res.success?
  end
  assert(conn_failed,
         "The untorified #{@conn_proto} connection didn't fail as expected:\n" +
         @conn_res.to_s)
end

Then /^the untorified connection is logged as dropped by the firewall$/ do
  port_suffix = @conn_port.nil? ? '' : ":#{@conn_port}"
  assert(
    firewall_has_dropped_packet_to?(
      @conn_host, proto: @conn_proto, port: @conn_port, uid: @conn_uid, gid: @conn_gid
    ),
    "No #{@conn_proto} packet to #{@conn_host}#{port_suffix} " \
    'was dropped by the firewall'
  )
end

When /^the system DNS is(?: still)? using the local DNS resolver$/ do
  resolvconf = $vm.file_content('/etc/resolv.conf')
  bad_lines = resolvconf.split("\n").select do |line|
    !line.start_with?('#') && !/^nameserver\s+127\.0\.0\.1$/.match(line)
  end
  assert_empty(
    bad_lines,
    "The following bad lines were found in /etc/resolv.conf:\n#{bad_lines.join("\n")}"
  )
end

STREAM_ISOLATION_INFO = {
  'htpdate'                        => {
    grep_monitor_expr: 'users:(("https-get-expir"',
    socksport:         9062,
    # htpdate is resolving names through the system resolver, not through socksport
    # (in order to have better error messages). Let it connect to local DNS!
    dns:               true,
  },
  'tails-security-check'           => {
    grep_monitor_expr: 'users:(("tails-security-"',
    socksport:         9062,
  },
  'tails-upgrade-frontend-wrapper' => {
    grep_monitor_expr: 'users:(("tails-iuk-get-u"',
    socksport:         9062,
  },
  'Tor Browser'                    => {
    grep_monitor_expr: 'users:(("firefox\.real"',
    socksport:         9050,
    controller:        true,
    netns:             'tbb',
  },
  'SSH'                            => {
    grep_monitor_expr: 'users:(("\(nc\|ssh\)"',
    socksport:         9050,
  },
}.freeze

def stream_isolation_info(application)
  STREAM_ISOLATION_INFO[application] || \
    raise("Unknown application '#{application}' for the stream isolation tests")
end

When /^I monitor the network connections of (.*)$/ do |application|
  @process_monitor_log = '/tmp/ss.log'
  $vm.execute_successfully("rm -f #{@process_monitor_log}")
  info = stream_isolation_info(application)
  netns_wrapper = info[:netns].nil? ? '' : "ip netns exec #{info[:netns]}"
  $vm.spawn('while true; do ' \
            "  #{netns_wrapper} ss -taupen " \
            "    | grep --line-buffered '#{info[:grep_monitor_expr]}' " \
            "    >> #{@process_monitor_log} ;" \
            'done')
end

Then /^I see that (.+) is properly stream isolated(?: after (\d+) seconds)?$/ do |application, delay|
  sleep delay.to_i if delay
  info = stream_isolation_info(application)
  expected_ports = [info[:socksport]]
  expected_ports << 951 if info[:controller]
  expected_ports << 53 if info[:dns]
  assert_not_nil(@process_monitor_log)
  log_lines = $vm.file_content(@process_monitor_log).split("\n")
  assert(!log_lines.empty?,
         "Couldn't see any connection made by #{application} so " \
         'something is wrong')
  log_lines.each do |line|
    ip_port = line.split(/\s+/)[5]
    assert(expected_ports.map { |port| "127.0.0.1:#{port}" }.include?(ip_port),
           "#{application} should only connect to #{expected_ports} but " \
           "was seen connecting to #{ip_port}")
  end
end

And /^I re-run tails-security-check$/ do
  $vm.execute_successfully(
    'systemctl --user restart tails-security-check.service',
    user: LIVE_USER
  )
end

And /^I re-run htpdate$/ do
  $vm.execute_successfully('systemctl stop htpdate && ' \
                           'rm -f /run/htpdate/* && ' \
                           'systemctl --no-block start htpdate.service')
  step 'the time has synced'
end

And /^I re-run tails-upgrade-frontend-wrapper$/ do
  $vm.execute_successfully('tails-upgrade-frontend-wrapper', user: LIVE_USER)
end

# Note about the "basic" Tor Connection Assistant steps: we have tests which will
# start Tor Connection Assistant (and connect directly to the Tor Network) in
# other languages, so we need to make those steps
# language-agnostic. Unfortunately this means interaction based on
# images is not suitable, so we try more general approaches.

When /^the Tor Connection Assistant (?:autostarts|is running)$/ do
  try_for(60) do
    tor_connection_assistant
  end
rescue Timeout::Error
  raise TorBootstrapFailure, 'TCA did not start'
end

def tor_connection_assistant(**opts)
  Dogtail::Application.new('Tor Connection', translation_domain: 'tails', **opts)
end

class TCAConnectionFailure < TorBootstrapFailure
end

class TCAConnectionTimeout < TorBootstrapFailure
end

class TCAForbiddenBridgeType < StandardError
end

Then /^the Tor Connection Assistant connects to Tor$/ do
  failure_reported_once = false
  failure_reported_twice = false
  try_for(120,
          msg:       'Timed out while waiting for TCA to connect to Tor',
          exception: TCAConnectionTimeout) do
    if tor_connection_assistant.child?(
      'Error connecting to Tor.*|Error asking for a bridge',
      roleName: 'label', retry: false
    )
      if failure_reported_once
        failure_reported_twice = true
        done = true
      else
        failure_reported_once = true
        done = false
        sleep 3
      end
    else
      done = tor_connection_assistant.child?(
        'Connected to Tor successfully', roleName: 'label',
                                         retry:    false
      ) || tor_connection_assistant.child?(
        'Connected to Tor successfully with bridges', roleName: 'label',
                                                      retry:    false
      )
    end
    done
  end
  raise TCAConnectionFailure, 'TCA failed to connect to Tor' if failure_reported_twice
end

Then /^the Tor Connection Assistant fails to connect to Tor$/ do
  step 'the Tor Connection Assistant connects to Tor'
rescue TCAConnectionFailure
  # Expected!
  next
rescue StandardError => e
  raise 'Expected TCAConnectionFailure to be raised but got ' \
        "#{e.class.name}: #{e}"
else
  raise 'TCA managed to connect to Tor but was expected to fail'
end

Then /^the Tor Connection Assistant knows that it's not the time sync that failed$/ do
  if tor_connection_assistant.child?('Fix Clock')
    raise 'TCA thinks that time sync might have failed'
  end
end

Then /^the Tor Connection Assistant knows that there might be a captive portal$/ do
  unless tor_connection_assistant.child?('Try Signing in to the Network')
    raise 'TCA does not think that there might be a captive portal'
  end
end

# Connectivity check server, used by tails-get-network-time
def connectivity_check_hostname
  url = $vm.file_content('/etc/tails-get-network-time.conf').match(/^url=(.*)/)[1]
  URI.parse(url).host
end

def connectivity_check_hosts
  # We locally resolve using the same dnsmasq instance as the VM under
  # testing will use when resolving the connectivity check hostname,
  # to increase the chances that we get the same results (tails#20515).
  Resolv::DNS.new(nameserver: [$vmnet.bridge_ip_address.to_s])
             .getaddresses(connectivity_check_hostname)
             .map(&:to_s)
end

def connectivity_check_allowed_nodes
  connectivity_check_hosts.map { |ip| { address: ip, port: 80 } }
end

def tca_configure(mode, connect: true, &block)
  step 'the Tor Connection Assistant is running'
  # this is the default, so why bother setting it?
  # Some scenario switch back from bridges to direct connection,
  # so we need to reset the value of this variable
  @user_wants_pluggable_transports = (mode == :hide)
  case mode
  when :easy
    radio_button_label = '<b>Connect to Tor _automatically</b>'
    # If we run the step "I make sure time sync before Tor connects cannot work",
    # @allowed_dns_queries is already initialized, and the corresponding
    # add_extra_allowed_hosts have already been called
    unless @allowed_dns_queries && !@allowed_dns_queries.empty?
      @allowed_dns_queries = ["#{connectivity_check_hostname}."]
      connectivity_check_hosts.each do |ip|
        add_extra_allowed_host(ip, 80)
      end
    end
    add_dns_to_extra_allowed_host
  when :hide
    @user_wants_pluggable_transports = true
    radio_button_label = '<b>Hide to my local network that I\'m connecting to Tor</b>'
  else
    raise "bad TCA configuration mode '#{mode}'"
  end
  # We generally run this right after TCA has started, which might be
  # so early that clicking the radio button doesn't always work, so we
  # have to retry.
  radio_button = tor_connection_assistant.child(
    radio_button_label, roleName: 'radio button'
  )
  try_for(10) do
    radio_button.doActionNamed('click')
    radio_button.checked?
  end
  block.call if block_given?
  return unless connect

  click_connect_to_tor
  step 'the Tor Connection Assistant connects to Tor'
  @screen.press('alt', 'F4')
end

When(/^I choose to connect to Tor automatically$/) do
  tca_configure(:easy, connect: false)
end

When /^I configure a direct connection in the Tor Connection Assistant$/ do
  tca_configure(:easy)
end

When(/^I look at the hide mode but then I go back$/) do
  tca_configure(:hide, connect: false) do
    click_connect_to_tor

    tor_connection_assistant.child(
      'Configure a Tor bridge',
      roleName: 'heading'
    )

    btn = tor_connection_assistant.child(
      '_Back',
      roleName: 'button'
    )
    assert btn.sensitive?
    btn.click
  end
end

# rubocop:disable Metrics/AbcSize
def chutney_bridges(bridge_type, chutney_tag: nil)
  chutney_tag = bridge_type if chutney_tag.nil?
  bridge_dirs = Dir.glob(
    "#{$config['TMPDIR']}/chutney-data/nodes/*#{chutney_tag}/"
  )
  assert(bridge_dirs.size.positive?, "No bridges of type '#{chutney_tag}' found")
  bridge_dirs.map do |bridge_dir|
    address = $vmnet.bridge_ip_address.to_s
    port = nil
    fingerprint = nil
    extra = nil
    if bridge_type == 'bridge'
      File.open("#{bridge_dir}/torrc") do |f|
        port = f.grep(/^OrPort\b/).first.split.last.split(':').last
      end
    else
      pt_re = /^ServerTransportListenAddr .*:(\d+)$/
      File.open("#{bridge_dir}/torrc") do |f|
        pt_lines = f.grep(pt_re)
        assert_equal(1, pt_lines.size)
        port = pt_lines.last.match(pt_re)[1]
      end
      if bridge_type == 'obfs4'
        File.open("#{bridge_dir}/pt_state/obfs4_bridgeline.txt") do |f|
          extra = f.readlines.last.chomp.sub(/^.* cert=/, 'cert=')
        end
      end
    end
    File.open("#{bridge_dir}/fingerprint") do |f|
      fingerprint = f.read.chomp.split.last
    end
    bridge_line = "#{bridge_type} #{address}:#{port}"
    [fingerprint, extra].each { |e| bridge_line += " #{e}" if e }
    {
      type:        bridge_type,
      address:,
      port:        port.to_i,
      fingerprint:,
      extra:,
      line:        bridge_line,
    }
  end
end
# rubocop:enable Metrics/AbcSize

def feed_qr_code_video_to_virtual_webcam(qrcode_image)
  white_image = '/usr/share/tails/test_suite/white.jpg'
  # Display a white picture for 15s, then slide in the QR code from
  # the right in 5s, and leave it there for another 10s.
  #
  # How to hack:
  #
  #  - The parameters are managed in this part: ((t-15)*w/5). That -15
  #    tells to start after 15s, that /5 is the speed (the highest
  #    the divider, the slowest is the transition).
  #  - We believe the -t 30 and -t 15 play a role, too.
  # rubocop:disable Layout/LineLength
  $vm.spawn(
    "ffmpeg -nostdin -re -loop 1 -t 30 -i #{white_image} -loop 1 -t 15 -i #{qrcode_image} -filter_complex \"[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:#FFFFFF@1[v0]; [1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:#FFFFFF@1,setpts=PTS-STARTPTS[v1]; [v0][v1] overlay=x='max(w-((t-15)*w/5)\,0)'[vv0]; [vv0] format=yuv420p [video]\" -map \"[video]\" -f v4l2 /dev/video0",
    user: LIVE_USER
  )
  # rubocop:enable Layout/LineLength
end

def setup_qrcode_bridges_on_webcam(bridges)
  $vm.execute_successfully('modprobe v4l2loopback')
  # rubocop:disable Style/StringConcatenation
  qrcode_image = save_qrcode(
    '[' +
    bridges.map { |bridge| "'#{bridge[:line]}'" }.join(', ') +
    ']'
  )
  # rubocop:enable Style/StringConcatenation
  $vm.file_copy_local(qrcode_image, '/tmp/qrcode.jpg')
  $vm.execute_successfully("chmod a+r '/tmp/qrcode.jpg'")
  feed_qr_code_video_to_virtual_webcam('/tmp/qrcode.jpg')
  # Give ffmpeg time to start pushing frames to the virtual webcam
  sleep 5
end

When /^I configure (?:some|the) (persistent )?(\w+) bridges (from a QR code )?in the Tor Connection Assistant(?: in (easy|hide) mode)?( without connecting|)$/ do |persistent, bridge_type, qr_code, mode, connect|
  # If the "mode" isn't specified we pick one that makes sense for
  # what is requested.
  config_mode = if mode.nil?
                  ['normal', 'default'].include?(bridge_type) ? :easy : :hide
                else
                  mode.to_sym
                end
  # Internally a "normal" bridge is called just "bridge" which we have
  # to respect below.
  bridge_type = 'bridge' if bridge_type == 'normal'
  connect = (connect == '')

  # XXX: giving up on a few worst offenders for now
  # rubocop:disable Metrics/BlockLength
  tca_configure(config_mode, connect:) do
    @user_wants_pluggable_transports = bridge_type != 'bridge'
    debug_log('user_wants_pluggable_transports = '\
              "#{@user_wants_pluggable_transports}")
    if config_mode == :easy
      tor_connection_assistant.child('Configure a Tor _bridge',
                                     roleName: 'check box')
                              .click
    end
    click_connect_to_tor
    if bridge_type == 'default'
      assert_equal(:easy, config_mode)

      @bridge_hosts = if @real_tor
                        bridges_to_ipport(
                          $vm.file_content('/usr/share/tails/tca/default_bridges.txt')
                        )
                      else
                        chutney_bridges('obfs4', chutney_tag: 'defbr').map do |bridge|
                          { address: bridge[:address], port: bridge[:port] }
                        end
                      end

      tor_connection_assistant.child('Use a _default bridge',
                                     roleName: 'radio button')
                              .click
    else
      add_dns_to_extra_allowed_host if bridge_type == 'webtunnel'
      bridges = if @real_tor
                  default_bridges_path = '/usr/share/tails/tca/default_bridges.txt'
                  all_bridges = $vm.file_content(default_bridges_path).lines + [
                    [
                      'webtunnel',
                      '[2001:db8:d6b7:10ae:b5cf:811a:7f22:4596]:443',
                      '770EA6412C8D3997ABFFF7173A3E53F1D3660167',
                      'url=https://shallotfarm.org/jcHgyp7m90iQr9QaVSprq1wP',
                    ].join(' '),
                    [
                      'bridge',
                      '[2001:db8:d6b7:10ae:b5cf:811a:7f22:bbbb]:443',
                    ].join(' '),
                  ]
                  matching = all_bridges.find { |b| b.start_with? bridge_type }&.rstrip
                  @allowed_dns_queries ||= []
                  @allowed_dns_queries += bridge_expected_dns_queries(matching)
                  bridges_to_ipport(matching).map do |addressport|
                    { line: matching }.merge(addressport)
                  end
                else
                  [chutney_bridges(bridge_type).first]
                end
      if qr_code
        # We currently support only 1 bridge
        setup_qrcode_bridges_on_webcam(bridges)
        tor_connection_assistant.child('_Ask for a bridge by email',
                                       roleName: 'radio button')
                                .click
        tor_connection_assistant.child('Scan QR code',
                                       roleName: 'button')
                                .click
        try_for(30) do
          all_labels = tor_connection_assistant.children(roleName: 'label')
          label = all_labels.find do |node|
            node.text.start_with? "Scanned #{bridge_type} bridge"
          end
          !label.nil?
        end
      else
        btn = tor_connection_assistant.child(
          '_Enter a bridge that you already know',
          roleName: 'radio button'
        )
        btn.click
        # we'd like to use btn.labelee, which is the semantic way to reach
        # the text entry
        # (for details, see label-for and labelled-by accessibility relations
        # in main.ui.in)
        # however, this doesn't seem to work anymore
        bridge_entry = tor_connection_assistant.child('Bridge', roleName: 'label')
                                               .parent
                                               .child(roleName: 'text')
        bridge_entry.text = bridges.first[:line]
      end
      @bridge_hosts = bridges.map do |bridge|
        { address: bridge[:address], port: bridge[:port] }
      end
      begin
        step 'the Tor Connection Assistant complains ' \
             'that normal bridges are not allowed'
      rescue Dogtail::Failure
        # There is no problem, so we can connect if we want
      else
        assert_equal(:hide, config_mode)
        raise TCAForbiddenBridgeType, 'Normal bridges are not allowed in hide mode'
      end
      if persistent
        toggle_button = tor_connection_assistant.child(
          'Save bridge to Persistent Storage',
          roleName: 'toggle button'
        )
        assert(!toggle_button.checked?)
        toggle_button.toggle
        try_for(10) { toggle_button.checked? }
      end
    end
  end
  # rubocop:enable Metrics/BlockLength
end

When /^I disable saving bridges to Persistent Storage$/ do
  toggle_button = tor_connection_assistant.child(
    'Save bridge to Persistent Storage',
    roleName: 'toggle button'
  )
  assert(toggle_button.checked?)
  toggle_button.toggle
  try_for(10) { !toggle_button.checked? }
end

When /^I unsuccessfully configure (a direct connection|some .* bridges) in the Tor Connection Assistant$/ do |conntype|
  step "I configure #{conntype} in the Tor Connection Assistant"
rescue TCAConnectionFailure
  # Expected!
  next
rescue StandardError => e
  raise 'Expected TCAConnectionFailure to be raised but got ' \
        "#{e.class.name}: #{e}"
else
  raise 'TCA managed to connect to Tor but was expected to fail'
end

When /^I try to configure some normal bridges in the Tor Connection Assistant in hide mode$/ do
  step 'I configure some normal bridges in the Tor Connection Assistant in hide mode'
rescue TCAForbiddenBridgeType
  # Expected!
  next
rescue StandardError => e
  raise 'Expected TCAForbiddenBridgeType to be raised but got ' \
        "#{e.class.name}: #{e}"
else
  raise 'TCA managed to connect to Tor but was expected to fail'
end

def mock_moat_response(response)
  response_json = JSON.pretty_generate(response)
  $vm.file_overwrite('/run/moat-response.json', response_json)
  moat_wrapper = <<~WRAPPER
    #!/bin/sh
    cat /run/moat-response.json
  WRAPPER
  $vm.file_overwrite('/usr/local/lib/tails-circumvention-settings', moat_wrapper)
end

Given /^the Moat distributor responds with the default bridges$/ do
  transport = 'obfs4'
  default_bridges = $vm.execute_successfully(
    "grep ^#{transport} /usr/share/tails/tca/default_bridges.txt | sort"
  ).stdout.chomp.split("\n")
  response = {
    "settings": [
      {
        "bridges": {
          "type":           transport,
          "source":         'builtin',
          "bridge_strings": default_bridges,
        },
      },
    ],
    "country":  'foo',
  }
  mock_moat_response(response)
end

Given /^the Moat distributor responds with an API error$/ do
  @mocked_moat_api_error = {
    'errors' => [
      {
        'code'   => 404,
        'detail' => 'No provided transport is available for this country',
      },
    ],
  }
  mock_moat_response(@mocked_moat_api_error)
end

When /^I configure Tor Connection to ask for bridge settings (?:based on my location|for "(.*)")$/ do |region|
  tca_configure(:easy, connect: false) do
    tor_connection_assistant.child(
      'Configure a Tor _bridge',
      roleName: 'check box'
    ).click
    click_connect_to_tor
    moat_radio = tor_connection_assistant.child(
      'Ask for a bridge based on your _region',
      roleName: 'radio button'
    )
    moat_radio.click
    if region
      combo_box = moat_radio.parent.child(roleName: 'combo box')
      combo_input = moat_radio.parent.child(roleName: 'text')
      old_combovalue = combo_box.combovalue
      assert_equal('automatic', old_combovalue)
      combo_input.text = region
      try_for(5) { old_combovalue != combo_box.combovalue }
    end
    click_connect_to_tor
  end
  @user_wants_pluggable_transports = true
end

When /^I accept Tor Connection's offer to use my persistent bridges$/ do
  @user_wants_pluggable_transports = true
  assert(
    tor_connection_assistant.child('Configure a Tor bridge',
                                   roleName: 'check box')
                            .checked?
  )
  click_connect_to_tor
  assert(
    tor_connection_assistant.child('Use a bridge that you already know',
                                   roleName: 'radio button').checked?
  )
  persistent_bridges_lines = [
    tor_connection_assistant.child(roleName: 'text')
                            .text.chomp,
  ]
  assert(persistent_bridges_lines.size.positive?)
end

Then(/^Tor Connection does not propose me to use Tor bridges$/) do
  assert_equal(
    false,
    tor_connection_assistant.child('Configure a Tor bridge',
                                   roleName: 'check box')
                            .checked?
  )
end

When /^I close the Tor Connection Assistant$/ do
  $vm.execute(
    'pkill -f /usr/lib/python3/dist-packages/tca/application.py'
  )
end

Then /^the Tor Connection Assistant reports that it failed to connect$/ do
  try_for(120) do
    tor_connection_assistant.child(
      'Error connecting to Tor.*|Error asking for a bridge', roleName: 'label'
    )
  end
end

Then /^the Tor Connection Assistant reports the Moat API error$/ do
  expected_error_code = 'moat_api_error'
  # We need to unset drop_accelerator because we'll look for a string
  # with two underscores which otherwise would be confused as two
  # accelerators, resulting in tripping a sanity check in translate().
  tor_connection_assistant(drop_accelerator: false)
    .child("Error code: #{expected_error_code}", roleName: 'label')
  tor_connection_assistant.child('Open _details', roleName: 'button').click
  details = Dogtail::Application.new('gnome-text-editor')
                                .child(roleName: 'text')
                                .text
  error_code = details.lines.first.chomp.delete_prefix('Code: ')
  assert_equal(expected_error_code, error_code)
  error_details = JSON.parse(details.lines.last.chomp)
  assert_equal(@mocked_moat_api_error['errors'], error_details)
end

Then /^the Tor Connection Assistant complains that normal bridges are not allowed$/ do
  tor_connection_assistant.child(
    'You need to configure a WebTunnel or an obfs4 bridge ' \
    'to hide that you are using Tor',
    roleName: 'label',
    retry:    false
  )
end

def click_connect_to_tor
  btn = nil
  try_for(10) do
    btn = tor_connection_assistant.child(
      '_Connect to Tor',
      roleName: 'button'
    )
    btn.sensitive?
  end
  assert_not_nil(btn)
  btn.click
end

When /^(?:I click "Connect to Tor"|I retry connecting to Tor)$/ do
  click_connect_to_tor
end

Then /^I can(not)? click the "Connect to Tor" button$/ do |cannot|
  can = cannot.nil?
  assert_equal(can, tor_connection_assistant.child('_Connect to Tor').sensitive?)
end

When /^I set the time zone in Tor Connection to "([^"]*)"$/ do |timezone|
  tor_connection_assistant.child('Fix Clock').click
  time_dialog = tor_connection_assistant.child('Tor Connection - Fix Clock',
                                               roleName: 'dialog')
  # We'd like to click the time zone label to open the selection
  # prompt, but labels expose no actions to Dogtail. Luckily it is
  # selected by default so we can activate it by pressing the Space
  # key.
  @screen.press('Space')

  def get_visible_results(dialog)
    table = dialog.child(roleName: 'tree table')
    table.children(roleName: 'table cell').select do |res|
      # Let's skip continents, but keep special timezones: UTC and GMT
      res.name.include? '/' or ['UTC', 'GMT'].include?(res.name)
    end
  end

  @screen.type(timezone)

  try_for(10) do
    # filtering could take some time, so let's wait until this has been properly done
    results = get_visible_results(time_dialog)
    results.length == 1
  end

  @screen.press('Return')

  try_for(5) do
    time_dialog.child('Apply', roleName: 'button').click
    true
  end

  # wait for the dialog to be closed
  try_for(30) do
    tor_connection_assistant.child('Tor Connection - Fix Clock')
  rescue Dogtail::Failure
    true
  else
    false
  end
end

def bridge_expected_dns_queries(line)
  return [] if ['obfs4', 'bridge'].include?(line&.split&.first)

  m = Regexp.new('\burl=https://([^/]+)(:\d+|)[/]').match(line)
  return [] if m.nil?

  ["#{m[1]}."]
end

def bridge_line_to_ipports(line)
  case line.split.first
  when 'obfs4', 'bridge'
    addresses = [/\s[a-f0-9.:\[\]]+:\d+\b/.match(line)[0]]
  when 'webtunnel'
    m = Regexp.new('\burl=https://([^/]+)(:\d+|)[/]').match(line)
    return [] if m.nil?

    domain = m[1]
    port = m[2].empty? ? '443' : m.captures[1]
    resolver = Resolv::DNS.new
    addresses = resolver.getaddresses(domain).map { |ip| "#{ip}:#{port}" }
  else
    raise "Unsupported bridge type '#{line.split.first}'"
  end
  addresses
    .reject(&:nil?)
    .map { |l| l.chomp.strip }
    .reject(&:empty?)
    .map do |address|
      ip, _colon, port = address.rpartition(':')
      { address: ip, port: port.to_i }
    end
end

def bridges_to_ipport(file_content)
  supported_transports = supported_bridge_transports
  # given the content of a default_bridges.txt, extract all IPs:Port,
  # returning an array of hashes; only IPv4 are considered
  file_content
    .chomp
    .split("\n")
    .filter { |l| supported_transports.include?(l.split.first) }
    .map { |l| bridge_line_to_ipports(l) }
    .flatten
end

Then /^all Internet traffic has only flowed through (Tor|the \w+ bridges)( or (?:fake )?connectivity check service|)$/ do |flow_target, connectivity_check|
  case flow_target
  when 'Tor'
    allowed_hosts = allowed_hosts_under_tor_enforcement
  when 'the default bridges'
    allowed_hosts = if @real_tor
                      bridges_to_ipport(
                        $vm.file_content('/usr/share/tails/tca/default_bridges.txt')
                      )
                    else
                      chutney_bridges('obfs4', chutney_tag: 'defbr').map do |b|
                        { address: b[:address], port: b[:port] }
                      end
                    end
  when 'the configured bridges'
    assert_not_nil(@bridge_hosts, 'No bridges has been configured via the ' \
                                  "'I configure some ... bridges in the " \
                                  "Tor Connection Assistant' step")
    allowed_hosts = @bridge_hosts
  else
    raise "Unsupported flow target '#{flow_target}'"
  end

  # NOTE: many scenarios that use the network do not explicitly allow
  # using the connectivity check service. They pass because we're
  # restoring a snapshot where time sync has already happened (most
  # often "I have started Tails from DVD and logged in and the network
  # is connected").
  if !connectivity_check.empty?
    if connectivity_check.include? 'fake'
      # The fake connectivity check service uses the LAN web server
      allowed_hosts << { address: @web_server_ip_addr, port: @web_server_port }
    else
      # Allow connections to the local DNS resolver, used by
      # tails-get-network-time to resolve the hostname of the
      # connectivity check service
      allowed_hosts << { address: $vmnet.bridge_ip_address.to_s, port: 53 }
      allowed_hosts += connectivity_check_allowed_nodes
      allowed_dns_queries = ["#{connectivity_check_hostname}."]
    end

  else
    allowed_dns_queries = []
  end

  flow_target_s = flow_target.delete_prefix('the ')
  allowed_hosts_s = allowed_hosts
                    .map { |address| "#{address[:address]}:#{address[:port]}" }
                    .join(', ')
  debug_log("These hosts (#{flow_target_s}) are allowed: #{allowed_hosts_s}")
  assert_all_connections(@sniffer.pcap_file) do |c|
    allowed_hosts.include?({ address: c.daddr, port: c.dport })
  end

  debug_log("Allowed hosts: #{allowed_hosts}")
  debug_log("Allowed DNS queries: #{allowed_dns_queries}")

  assert_no_leaks(@sniffer.pcap_file, allowed_hosts, allowed_dns_queries)
  debug_useless_dns_exceptions(@sniffer.pcap_file, allowed_dns_queries)
end

Given /^the Tor network( and default bridges)? (?:is|are) (un)?blocked$/ do |default_bridges, unblock|
  relay_dirs = Dir.glob(
    "#{$config['TMPDIR']}/chutney-data/nodes/*{auth,ba,relay}/"
  )
  relays = relay_dirs.map do |relay_dir|
    File.open("#{relay_dir}/torrc") do |f|
      torrc = f.readlines
      [
        torrc.grep(/^Address\b/).first.split.last,
        torrc.grep(/^OrPort\b/).first.split.last.split(':').last.to_i,
      ]
    end
  end
  if default_bridges
    chutney_bridges('obfs4', chutney_tag: 'defbr').each do |bridge|
      relays << [bridge[:address], bridge[:port]]
    end
  end
  relays.each do |address, port|
    command = iptables_filter_add(!unblock,
                                  'REJECT --reject-with icmp-port-unreachable',
                                  address,
                                  port)
    unless unblock
      $vm.file_append('/etc/NetworkManager/dispatcher.d/00-firewall.sh',
                      "#{command}\n")
    end
  end
  if unblock
    $vm.execute_successfully(
      'cp ' \
      '/lib/live/mount/rootfs/filesystem.squashfs' \
      '/etc/NetworkManager/dispatcher.d/00-firewall.sh ' \
      '/etc/NetworkManager/dispatcher.d/00-firewall.sh'
    )
  end
  @tor_network_is_blocked = !unblock
end

Then /^Tor is configured to use the default bridges$/ do
  use_bridges = $vm.execute_successfully(
    '/usr/local/lib/tor_variable get --type=conf UseBridges'
  ).stdout.chomp.to_i
  assert_equal(1, use_bridges, 'UseBridges is not set')
  default_bridges = $vm.execute_successfully(
    'grep ^obfs4 /usr/share/tails/tca/default_bridges.txt | sort'
  ).stdout.chomp.split("\n").to_set
  assert(default_bridges.size.positive?, 'No default bridges were found')
  current_bridges = $vm.execute_successfully(
    '/usr/local/lib/tor_variable get --type=conf Bridge | sort'
  ).stdout.chomp.split("\n").to_set

  not_default = current_bridges - default_bridges
  not_default_text = not_default.to_a.join("\n")
  assert(not_default.empty?,
         "Some current bridges are not default ones:\n#{not_default_text}")
end

Then /^Tor is using the same configuration as before$/ do
  assert(@tor_success_configs.size >= 2,
         'We need at least two configs to compare but have only ' \
         "#{@tor_success_configs.size}")
  assert_equal(
    @tor_success_configs[-2],
    @tor_success_configs[-1]
  )
end

Then /^tca.conf is empty$/ do
  assert($vm.file_empty?('/var/lib/tca/tca.conf'))
end

def tca_conf(conf_file = '/var/lib/tca/tca.conf')
  JSON.parse($vm.file_content(conf_file))
end

Then /^tca.conf includes no bridge$/ do
  assert_equal([], tca_conf['tor']['bridges'])
end

Then /^tca.conf includes the configured bridges$/ do
  assert_equal(
    @bridge_hosts,
    tca_conf['tor']['bridges'].map do |bridge|
      bridge_parts = bridge.split
      bridge_info = if bridge_parts[0] == 'obfs4'
                      bridge_parts[1]
                    else
                      bridge_parts[0]
                    end.split(':')
      { address: bridge_info[0], port: bridge_info[1].to_i }
    end
  )
end

When /^I open the Unsafe Browser from Tor Connection$/ do
  tor_connection_assistant.child('Try Signing in to the Network').click
  try_for(30) do
    Dogtail::Application.new('Firefox')
  end
end

def disable_tor_reject_internal_addresses
  client_torrc_lines = [
    'ClientDNSRejectInternalAddresses 0',
    'ClientRejectInternalAddresses 0',
  ]
  $vm.file_append('/etc/tor/torrc', client_torrc_lines)
  $vm.execute('systemctl stop tor@default.service')
  $vm.execute('systemctl --no-block restart tails-tor-has-bootstrapped.target')
  $vm.execute('systemctl start tor@default.service')
  wait_until_tor_is_working
end

def allow_connecting_to_possibly_rfc1918_host(host)
  resolver = Resolv::DNS.new
  rfc1918_ips = resolver.getaddresses(host).select do |addr|
    # This crude "is it a RFC 1918 IP address?" check is just accurate enough
    # for our current needs. We'll improve it if/as needed.
    addr.instance_of?(Resolv::IPv4) && addr.to_s.start_with?('192.168.')
  end
  disable_tor_reject_internal_addresses if rfc1918_ips.count.positive?
  rfc1918_ips.each do |ip|
    add_extra_allowed_host(ip.to_s, 443)
  end
end

Then /^the Tor Connection Assistant reports that I am not connected to a local network$/ do
  tor_connection_assistant.child('No Wi-Fi hardware detected')
end
When(/^I plug a Wi-Fi adapter$/) do
  $vm.execute_successfully('modprobe mac80211_hwsim radios=1')
end

Then(/^Tor Connection suggests me to connect to Wi-Fi$/) do
  tor_connection_assistant.child('Connect to a local network',
                                 roleName: 'label')
end

Then(/^I click on the Wi-Fi settings$/) do
  tor_connection_assistant.child('Open Wi-Fi Settings', roleName: 'button').click
end

Then(/^The Wi-Fi settings are displayed$/) do
  Dogtail::Application.new('gnome-control-center')
                      .child('Wi-Fi', roleName: 'grouping')
                      .child('Wi-Fi', roleName: 'check box')
end

def torrc_bridges
  $vm.file_content('/etc/tor/torrc').lines.grep(/^Bridge\s/)
end

def supported_bridge_transports
  transports = JSON.parse(
    $vm.execute_successfully(
      'python3 -c "import json; import tca.torutils; ' \
      'print(json.dumps(list(tca.torutils.VALID_BRIDGE_TYPES)))"'
    ).stdout
  )
  # Sanity check
  assert_include(transports, 'obfs4')
  transports
end

Given /^no bridges are configured in torrc$/ do
  assert_equal(0, torrc_bridges.size)
end

Then /^some real world bridges are eventually configured in torrc$/ do
  expected_transports = supported_bridge_transports
  try_for(60) do
    bridges = torrc_bridges
    assert_not_empty(bridges, 'there are no bridge lines in torrc')
    bridges.each do |line|
      line_split = line.split
      if line_split.size == 2
        transport = 'bridge'
        addr_port = line_split.last
      else
        _, transport, addr_port, = line_split
      end
      assert_include(expected_transports, transport)
      addr = addr_port.sub(/:\d+$/, '')
      assert(!IPAddr.new(addr).private?,
             'real world bridges do not have private IP addresses')
    end
  end
end
