require 'tempfile'

class SSHServer
  def initialize(sshd_host, sshd_port, authorized_keys = nil)
    @sshd_host = sshd_host
    @sshd_port = sshd_port
    @authorized_keys = authorized_keys
    @pid = nil
  end

  def start
    @sshd_key_file = Tempfile.new('ssh_host_rsa_key', $config['TMPDIR'])
    # 'hack' to prevent ssh-keygen from prompting to overwrite the file
    File.delete(@sshd_key_file.path)
    cmd_helper(
      ['ssh-keygen', '-t', 'rsa', '-N', '', '-f', @sshd_key_file.path.to_s]
    )
    @sshd_key_file.close

    sshd_config = <<~CONFIG
      Port #{@sshd_port}
      ListenAddress #{@sshd_host}
      HostKey #{@sshd_key_file.path}
      Pidfile #{$config['TMPDIR']}/ssh.pid
    CONFIG

    @sshd_config_file = Tempfile.new('sshd_config', $config['TMPDIR'])
    @sshd_config_file.write(sshd_config)

    if @authorized_keys
      @authorized_keys_file = Tempfile.new('authorized_keys', $config['TMPDIR'])
      @authorized_keys_file.write(@authorized_keys)
      @authorized_keys_file.close
      @sshd_config_file.write(
        "AuthorizedKeysFile #{@authorized_keys_file.path}"
      )
    end

    @sshd_config_file.close

    cmd = ['/usr/sbin/sshd', '-4', '-f', @sshd_config_file.path, '-D']

    job = IO.popen(cmd)
    @pid = job.pid
  end

  def stop
    File.delete("#{@sshd_key_file.path}.pub")
    File.delete("#{$config['TMPDIR']}/ssh.pid")
    begin
      Process.kill('TERM', @pid)
      Process.wait(@pid)
    rescue StandardError
      # noop
    end
  end

  def active?
    begin
      ret = Process.kill(0, @pid)
    rescue Errno::ESRCH => e
      return false if e.message == 'No such process'

      raise e
    end
    assert_equal(1, ret, "This shouldn't happen")
    true
  end
end
