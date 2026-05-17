require 'English'

class Display
  def initialize(domain, x_display)
    @domain = domain
    @x_display = x_display
  end

  def active?
    xlsclients_p = IO.popen(['xlsclients', '-display', @x_display,
                             { err: ['/dev/null', 'w'] },])
    x_clients = xlsclients_p.readlines.map { |l| l.split(/\s+/)[1] }
    Process.wait(xlsclients_p.pid)
    x_clients.any? { |c| c == 'virt-viewer' }
  end

  def start
    assert_nothing_raised(
      'No window manager is running which is required by virt-viewer'
    ) do
      cmd_helper(['pgrep', '--uid', Process.uid.to_s, '-f',
                  "xfwm4 --display=#{@x_display}",])
    end
    @virtviewer = IO.popen(['virt-viewer',
                            '--direct',
                            '--kiosk',
                            '--kiosk-quit=on-disconnect',
                            '--spice-disable-audio',
                            '--connect', 'qemu:///system',
                            '--display', @x_display,
                            @domain,
                            { err: ['/dev/null', 'w'] },])
    # We wait for the display to be active to not lose actions
    # (e.g. key presses) that come immediately after starting (or
    # restoring) a vm
    try_for(20, delay: 0.1, msg: 'virt-viewer failed to start') do
      active?
    end
  end

  def stop
    return if @virtviewer.nil?

    Process.kill('TERM', @virtviewer.pid)
    @virtviewer.close
  rescue IOError
    # IO.pid throws this if the process wasn't started yet. Possibly
    # there's a race when doing a start() and then quickly running
    # stop().
  end

  def restart
    stop
    start
  end

  def screenshot(target)
    # Restart the virt-viewer connection if it's not active anymore
    # (for example because the user connected via virt-viewer themselves)
    restart unless active?
    FileUtils.rm_f(target)
    popen_wait(['import', '-quality', '100%', '-window', 'root', target])
    assert($CHILD_STATUS.success?)
    assert(File.exist?(target))
  end
end
