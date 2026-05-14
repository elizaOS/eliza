require 'socket'

def assert_not_ipaddr(str)
  err_msg = "'#{str}' looks like a LAN IP address."
  assert_raise(IPAddr::InvalidAddressError, err_msg) do
    IPAddr.new(str)
  end
end

def read_and_validate_ssh_config(srv_type)
  conf = $config[srv_type]
  begin
    required_settings = ['private_key', 'public_key', 'username', 'hostname']
    required_settings.each do |key|
      assert(conf.key?(key))
      assert_not_nil(conf[key])
      assert(!conf[key].empty?)
    end
  rescue NoMethodError
    raise(
      "Your #{srv_type} config is incorrect or missing from your local " \
      "configuration file (#{LOCAL_CONFIG_FILE}). " \
      'See wiki/src/contribute/release_process/test/usage.mdwn for the format.'
    )
  end

  case srv_type
  when 'SSH'
    @ssh_host        = conf['hostname']
    @ssh_port        = conf['port'].to_i if conf['port']
    @ssh_username    = conf['username']
    @ssh_prompt_re   = /^#{@ssh_username}@[a-z]+[:space:]+.*[$]/
    assert_not_ipaddr(@ssh_host)
  end
end

Given /^I have the SSH key pair for an? (Git|SSH) (?:repository|server)( on the LAN)?$/ do |server_type, lan|
  $vm.execute_successfully("install -m 0700 -d '/home/#{LIVE_USER}/.ssh/'",
                           user: LIVE_USER)
  if server_type == 'Git' || lan
    secret_key = $config['Unsafe_SSH_private_key']
    public_key = $config['Unsafe_SSH_public_key']
  else
    read_and_validate_ssh_config(server_type)
    secret_key = $config[server_type]['private_key']
    public_key = $config[server_type]['public_key']
  end

  $vm.execute_successfully(
    "echo '#{secret_key}' > '/home/#{LIVE_USER}/.ssh/id_rsa'",
    user: LIVE_USER
  )
  $vm.execute_successfully(
    "echo '#{public_key}' > '/home/#{LIVE_USER}/.ssh/id_rsa.pub'",
    user: LIVE_USER
  )
  $vm.execute_successfully("chmod 0600 '/home/#{LIVE_USER}/.ssh/'id*",
                           user: LIVE_USER)
end

Given /^I (?:am prompted to )?verify the SSH fingerprint for the (?:Git|SSH) (?:repository|server)$/ do
  try_for(60) do
    Dogtail::Application.new('kgx')
                        .child('Terminal', roleName: 'terminal')
                        .text['Are you sure you want to continue connecting']
  end
  sleep 1 # brief pause to ensure that the following keystrokes do not get lost
  @screen.type('yes', ['Return'])
end

def get_free_tcp_port
  server = TCPServer.new('127.0.0.1', 0)
  server.addr[1]
ensure
  server.close
end

Given /^an SSH server is running on the LAN$/ do
  @sshd_server_port = get_free_tcp_port
  @sshd_server_host = $vmnet.bridge_ip_address.to_s
  sshd = SSHServer.new(@sshd_server_host, @sshd_server_port)
  sshd.start
  add_extra_allowed_host(@sshd_server_host, @sshd_server_port)
  add_after_scenario_hook { sshd.stop }
end

When /^I connect to an SSH server on the (Internet|LAN)$/ do |location|
  case location
  when 'Internet'
    read_and_validate_ssh_config('SSH')
  when 'LAN'
    @ssh_port = @sshd_server_port
    @ssh_username = 'user'
    @ssh_host = @sshd_server_host
  end

  ssh_port_suffix = "-p #{@ssh_port}" if @ssh_port

  cmd = "ssh #{@ssh_username}@#{@ssh_host} #{ssh_port_suffix}"

  step 'process "ssh" is not running'

  recovery_proc = proc do
    ensure_process_is_terminated('ssh')
    step 'I run "clear" in Console'
  end

  retry_tor(recovery_proc) do
    step "I run \"#{cmd}\" in Console"
    step 'process "ssh" is running within 10 seconds'
    step 'I verify the SSH fingerprint for the SSH server'
  end
end

Then /^I have successfully logged into the SSH server$/ do
  try_for(60) do
    @ssh_prompt_re.match(
      Dogtail::Application.new('kgx')
                          .child('Terminal', roleName: 'terminal')
                          .text
    )
  end
end
