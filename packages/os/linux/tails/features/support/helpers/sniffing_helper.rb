#
# Sniffer is a very dumb wrapper to start and stop tcpdump instances, possibly
# with customized filters. Captured traffic is stored in files whose name
# depends on the sniffer name. The resulting captured packets for each sniffer
# can be accessed as an array through its `packets` method.
#
# Use of more rubyish internal ways to sniff a network like with pcap-able gems
# is waaay to much resource consuming, not much reliable and soooo slow. Let's
# not bother too much with that. :)
#
# Should put all that in a Module.

class Sniffer
  attr_reader :name, :pcap_file, :pid

  def initialize(name, vmnet)
    @name = name
    @vmnet = vmnet
    pcap_name = sanitize_filename("#{name}.pcap")
    @pcap_file = "#{$config['TMPDIR']}/#{pcap_name}"
  end

  def tcpdump
    candidates = ['/usr/bin/tcpdump', '/usr/sbin/tcpdump']
    candidates.select { |candidate| File.exist?(candidate) }.first
  end

  def capture
    job = IO.popen(
      [
        tcpdump,
        '-n',
        '-U',
        '--immediate-mode',
        '-i', @vmnet.bridge_name,
        '-w', @pcap_file,
        { err: ['/dev/null', 'w'] },
      ]
    )
    @pid = job.pid
  end

  def stop
    Process.kill('TERM', @pid)
    Process.wait(@pid)
  rescue StandardError
    # noop
  end

  def clear
    File.delete(@pcap_file) if File.exist?(@pcap_file)
  end
end
