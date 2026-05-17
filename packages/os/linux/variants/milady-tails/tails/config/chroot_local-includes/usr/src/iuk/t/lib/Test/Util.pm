package Test::Util;

use 5.10.1;
use strictures;

use Carp;
use Carp::Assert;
use English qw{-no_match_vars};
use List::Util qw{first};
use Function::Parameters;
use IPC::System::Simple qw{capture capturex systemx $EXITVAL EXIT_ANY};
use Path::Tiny;
use Sys::Filesystem ();
use Tails::IUK::Utils qw{run_as_root stdout_as_root};
use Test::More;
use Types::Path::Tiny qw{AbsDir AbsPath};
use Types::Standard qw{ArrayRef Bool HashRef Int Maybe Str};

use Exporter;
our @ISA = qw{Exporter};
our @EXPORT_OK = (
    qw{make_iuk},
);


=head1 FUNCTIONS

=cut

fun kill_httpd ($c) {
    foreach my $pid_key (qw{http_pid https_pid}) {
        my $pid = $c->{stash}->{scenario}->{server}->{$pid_key};
        is(kill(9, $pid), 1, "Killed PID $pid" ) if defined $pid;
    }
}

fun upgrade_description_header ($product_name, $initial_install_version, $build_target, $channel) {
    return <<EOF
product-name: $product_name
initial-install-version: $initial_install_version
channel: $channel
build-target: $build_target
EOF
;
}

# $mount may be a device or mountpoint
fun mount_options ($mount) {
    my $fs = Sys::Filesystem->new();
    return split(/,/, $fs->options($mount));
}

# $mount may be a device or mountpoint
fun has_mount_option ($mount, $option) {
    grep { $_ eq $option } mount_options($mount);
}

fun remount_for_root_ro ($device, $mountpoint) {
    run_as_root('umount', '-l', $mountpoint);
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to umount '$mountpoint'.");

    run_as_root('mount', '-o', 'umask=0022', $device, $mountpoint);
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to mount '$mountpoint'.");

    run_as_root('mount', '-o', 'remount,ro', $mountpoint);
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to remount '$mountpoint' read-only.");
}

fun remount_for_me_rw ($device, $mountpoint) {
    run_as_root('umount', '-l', $mountpoint);
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to umount '$mountpoint'.");

    my @gids = split(/ /, $GID);
    run_as_root('mount', '-o', "rw,uid=$UID,gid=$gids[0]", $device, $mountpoint);
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to mount '$mountpoint'.");
}

# $size is in MB
fun prepare_live_device ($backing_file, $mountpoint, $size = 64) {
    system(qw{dd status=none if=/dev/zero bs=1M}, "of=$backing_file", "count=$size");
    capturex(
        qw{/sbin/sgdisk --clear --new=1:0:0},
        qw{--typecode=1:C12A7328-F81F-11D2-BA4B-00A0C93EC93B --change-name=Tails},
        $backing_file,
    );
    stdout_as_root(qw{kpartx -a -s}, $backing_file);

    # output looks like "loop0p1 : 0 128991 /dev/loop0 2048"
    my $kpartx_output = stdout_as_root(qw{kpartx -l}, $backing_file);
    my ($system_partition_basename, $boot_device) = (
        $kpartx_output =~ m{
                               \A (loop [0-9]+ p [0-9]+)
                               \s+ [:] \s+ [0-9]+ \s+ [0-9]+ \s+
                               (/dev/loop [0-9]+)
                               \s+ \d+
                       }xms)
        or croak("Failed to parse kpartx output:\n$kpartx_output");
    my @dmsetup_ls_output = stdout_as_root(qw{dmsetup ls});
    my $dm_line = first {
        m{^ $system_partition_basename \s+ [(] 25[34] : \d+ [)]$}xms
    } @dmsetup_ls_output
        or croak("Failed to parse dmsetup ls output.");
    my ($system_partition_dm_id) = (
        $dm_line =~ m{^ $system_partition_basename \s+ [(] 25[34] : (\d+) [)]$}xms
    ) or croak("Failed to parse dmsetup ls line output:\n$dm_line");
    my $system_partition = "/dev/dm-$system_partition_dm_id";

    stdout_as_root(qw{mkdosfs -F 32}, $system_partition);

    path($mountpoint)->mkpath;
    my @gids = split(/ /, $GID);
    run_as_root(
        "mount", "-o", "uid=$UID,gid=$gids[0],umask=0022", '-t', 'vfat',
        $system_partition, $mountpoint
    );

    path($mountpoint, 'live')->mkpath;
    for my $basename ('filesystem.squashfs', 'vmlinuz', 'initrd.img') {
        my $file = path($mountpoint, 'live', $basename);
        $file->touch;
        ok(-e $file);
    }
    my $modules_file = path($mountpoint, 'live', 'Tails.module');
    $modules_file->spew("filesystem.squashfs\n");
    my $syslinux_dir = $mountpoint->child('syslinux');
    $syslinux_dir->mkpath;

    remount_for_root_ro($system_partition, $mountpoint);

    ok(-e $modules_file);
    ok(-d $syslinux_dir);
    ok(  has_mount_option($mountpoint, 'ro'));
    ok(! has_mount_option($mountpoint, 'rw'));

    return (
        boot_device      => $boot_device,
        system_partition => $system_partition
    );
}

fun make_iuk (AbsPath    $iuk_filename,
              Bool       :$include_format_file = 1,
              ArrayRef   :$root_files = [],
              ArrayRef   :$overlay_files = [],
              ArrayRef   :$overlay_filenames = [],
              HashRef    :$overlay_copied_files = {},
              Maybe[Int] :$overlay_files_size = undef,
              Maybe[Str] :$overlay_files_content = undef,
          ) {
    my $tempdir = Path::Tiny->tempdir;
    if (@$overlay_filenames) {
        assert(defined $overlay_files_content || defined $overlay_files_size);
        assert(! (defined $overlay_files_content && defined $overlay_files_size) );
    }
    path($tempdir, 'FORMAT')->spew(2) if $include_format_file;
    unless (grep { $_ eq 'control.yml' } @{$root_files}) {
        path($tempdir, 'control.yml')->touch;
    }
    path($_)->move($tempdir->child($_->basename)) for @{$root_files};
    my $overlay_dir = $tempdir->child('overlay');
    $overlay_dir->mkpath;
    path($_)->move($overlay_dir->child($_->basename)) for @{$overlay_files};
    foreach (@{$overlay_filenames}) {
        if (defined $overlay_files_content) {
            path($overlay_dir, $_)->parent->mkpath;
            path($overlay_dir, $_)->spew($overlay_files_content);
        }
        else {
            systemx(
                "dd", 'status=none', "if=/dev/zero", "of=".$overlay_dir->child($_),
                "bs=1M", "count=".$overlay_files_size
            );
        }
    }
    while (my ($src, $dst) = each %$overlay_copied_files) {
        $overlay_dir->child($dst)->parent->mkpath;
        path($src)->copy($overlay_dir->child($dst));
    }

    my $gensquashfs_output = capture(
        EXIT_ANY,
        "gensquashfs --quiet --force --pack-dir '$tempdir' '$iuk_filename' 2>&1"
    );
    $EXITVAL == 0 or croak "gensquashfs failed: $gensquashfs_output";
}

1;
