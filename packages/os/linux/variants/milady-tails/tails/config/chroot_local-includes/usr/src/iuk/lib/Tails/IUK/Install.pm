=head1 NAME

Tails::IUK::Install - install an Incremental Upgrade Kit

=cut

package Tails::IUK::Install;

no Moo::sification;
use Moo;
use MooX::HandlesVia;

use 5.10.1;
use strictures 2;

use autodie qw(:all);
use Carp;
use Carp::Assert::More;
use Cwd;
use Data::Dumper;
use File::Copy;
use File::Temp qw{tempfile};
use Function::Parameters;
use Path::Tiny;
use Try::Tiny;
use Tails::IUK::Read;
use Tails::IUK::Utils qw{run_as_root space_available_in};
use Tails::RunningSystem;
use Types::Path::Tiny qw{AbsDir AbsFile AbsPath};
use Types::Standard qw{ArrayRef InstanceOf Str};

use namespace::clean;

use MooX::Options;


=head1 ATTRIBUTES

=cut

has 'reader' =>
    is      => 'lazy',
    isa     => InstanceOf['Tails::IUK::Read'],
    handles => [
        qw{file delete_files delete_files_count},
        qw{space_needed squashfs_in_overlay} ];

option 'override_liveos_mountpoint' =>
    is        => 'lazy',
    isa       => AbsDir,
    coerce    => AbsDir->coercion,
    format    => 's',
    predicate => 1;

option 'override_system_partition_file' =>
    is        => 'lazy',
    isa       => AbsPath,
    coerce    => AbsPath->coercion,
    format    => 's',
    predicate => 1;

option 'override_boot_device_file' =>
    is        => 'lazy',
    isa       => AbsPath,
    coerce    => AbsPath->coercion,
    format    => 's',
    predicate => 1;

has 'modules_file' =>
    is  => 'lazy',
    isa => AbsFile;

has 'from_file' =>
    required => 1,
    is       => 'ro',
    isa      => AbsFile,
    coerce   => AbsFile->coercion;

has 'installed_squashfs' =>
    is          => 'lazy',
    isa         => ArrayRef,
    handles_via => 'Array',
    handles     => {
        record_installed_squashfs => 'push',
        all_installed_squashfs    => 'elements',
    };

has 'running_system' =>
    is      => 'lazy',
    isa     => InstanceOf['Tails::RunningSystem'],
    handles => [ qw{boot_device_file system_partition_file liveos_mountpoint} ];


=head1 CONSTRUCTORS, BUILDERS AND DESTRUCTORS

=cut

method _build_installed_squashfs () { [] }

method _build_modules_file () {
    path($self->liveos_mountpoint, 'live', 'Tails.module');
}

method _build_reader () {
    Tails::IUK::Read->new_from_file($self->from_file);
}

method _build_running_system () {
    my @args;
    for (qw{boot_device_file system_partition_file liveos_mountpoint}) {
        my $attribute = "override_$_";
        my $predicate = "has_$attribute";
        if ($self->$predicate) {
            push @args, ($_ => $self->$attribute)
        }
    }
    Tails::RunningSystem->new(@args);
}


=head1 METHODS

=cut

method fatal (@msg) {
    Tails::IUK::Utils::fatal(
        msg => \@msg,
    );
}

method space_available () {
    space_available_in($self->liveos_mountpoint);
}

method delete_obsolete_squashfs_diffs () {
    my @keep = (
        $self->liveos_mountpoint->child('live', 'filesystem.squashfs'),
        (map {path($self->liveos_mountpoint, 'live', $_)}
             $self->all_installed_squashfs),
    );

    for my $candidate ($self->liveos_mountpoint->path('live')->children) {
        next if "$candidate" !~ m{[.] squashfs\z}xms;
        next if grep { "$candidate" eq "$_" } @keep;
        run_as_root('rm', '--force', "$candidate");
    }
}

method upgrade_modules_file () {
    my @installed_squashfs = $self->all_installed_squashfs;

    my $new_squashfs_str = join("\n", map { path($_)->basename } @installed_squashfs);
    my ($temp_fh, $temp_file) = tempfile;
    copy($self->modules_file->stringify, $temp_fh)
        or $self->fatal(sprintf(
            "Could not copy modules file ('%s') to temporary file ('%s')",
            $self->modules_file, $temp_file,
        ));
    close $temp_fh;

    $temp_fh = path($temp_file)->openw;
    say $temp_fh 'filesystem.squashfs', "\n", $new_squashfs_str;
    close $temp_fh;
    system('sync');

    run_as_root('nocache', '/bin/cp', '--force', $temp_file, $self->modules_file);
    system('sync', $self->modules_file);
}

method remount_liveos_rw () {
    run_as_root(qw{mount -o}, "remount,rw", $self->liveos_mountpoint);
}

method remount_liveos_sync () {
    run_as_root(qw{mount -o}, "remount,sync", $self->liveos_mountpoint);
}

method run () {
    unless ($self->space_available > $self->space_needed) {
        $self->fatal(
            "There is too little available space on Tails system partition, aborting"
        );
    }

    $self->remount_liveos_rw;

    # In a real Tails, /lib/live/mount/medium is not writable by non-root.
    run_as_root(
        'rsync',
        '--recursive',
        '--links',
        '--perms',
        '--times',
        '--chown=root:root',
        $self->reader->overlay_dir . '/',
        $self->liveos_mountpoint . '/'
    );

    $self->record_installed_squashfs($self->squashfs_in_overlay);

    if ($self->delete_files_count) {
        run_as_root(
            'rm', '--recursive', '--force',
            map { path($self->liveos_mountpoint, $_) } @{$self->delete_files}
        );
    }

    $self->remount_liveos_sync;

    $self->upgrade_modules_file;

    $self->delete_obsolete_squashfs_diffs;

    # upgrade syslinux' ldlinux.sys
    my $syslinux = path($self->liveos_mountpoint, qw{utils linux syslinux});
    run_as_root($syslinux, qw{-d syslinux}, $self->system_partition_file)
        if -e $syslinux;

    # upgrade the MBR
    my $mbr = path($self->liveos_mountpoint, qw{utils mbr mbr.bin});
    run_as_root(
        'dd', 'status=none', "if=$mbr", 'of='.$self->boot_device_file, 'bs=1', 'count=440',
    ) if -e $mbr;

    system('sync');
}

no Moo;
1;
