=head1 NAME

Tails::IUK - Incremental Upgrade Kit class

=cut

package Tails::IUK;

no Moo::sification;
use Moo;
use MooX::HandlesVia;

use 5.10.0;
use strictures 2;

use autodie qw(:all);
use Carp;
use Carp::Assert;
use Carp::Assert::More;
use Cwd;
use Data::Dumper;
use Device::Cdio::ISO9660;
use Device::Cdio::ISO9660::IFS;
use English qw{-no_match_vars};
use File::Basename;
use File::Spec::Functions;
use Function::Parameters;
use List::Util qw{first};
use Path::Tiny;
use Tails::IUK::Utils qw{extract_file_from_iso extract_here_file_from_iso run_as_root};
use Types::Path::Tiny qw{AbsDir AbsFile AbsPath File};
use Types::Standard qw(ArrayRef Enum Str);
use Try::Tiny;
use YAML::Any;

use namespace::clean;

use MooX::Options;


=head1 ATTRIBUTES

=cut

option "$_" => (
    required => 1,
    is       => 'ro',
    isa      => AbsFile,
    coerce   => AbsFile->coercion,
    format   => 's',
) for (qw{old_iso new_iso});

option 'squashfs_diff_name' =>
    required      => 1,
    is            => 'ro',
    isa           => Str,
    format        => 's',
    documentation => q{Name of the SquashFS diff file that will be installed into the system partition};

option 'outfile' =>
    required      => 1,
    is            => 'lazy',
    isa           => AbsPath,
    coerce        => AbsPath->coercion,
    format        => 's',
    documentation => q{Location of the created IUK};

has 'format_version' =>
    is  => 'lazy',
    isa => Str;

has "$_" =>
    is  => 'lazy',
    isa => ArrayRef
for (qw{delete_files new_kernels});

has "$_" =>
    is  => 'lazy',
    isa => AbsDir
for (qw{tempdir overlay_dir squashfs_src_dir});

has 'gensquashfs_options' =>
    is          => 'lazy',
    isa         => ArrayRef,
    handles_via => 'Array',
    handles     => {
        list_gensquashfs_options => 'elements',
    };

option 'gensquashfs_lock_file' =>
    is            => 'lazy',
    isa           => AbsPath,
    coerce        => AbsPath->coercion,
    format        => 's',
    predicate     => 1,
    documentation => q{Location of the gensquashfs lock file};

has 'gensquashfs_prefix_cmd' =>
    is          => 'lazy',
    isa         => ArrayRef,
    handles_via => 'Array',
    handles     => {
        list_gensquashfs_prefix_cmd => 'elements',
    };

option 'ignore_if_same_content' =>
    is            => 'lazy',
    isa           => ArrayRef,
    handles_via   => 'Array',
    format        => 's@',
    documentation => q{Do not include this file in the SquashFS if its content}.
                     q{has not changed. Globs are supported.};


=head1 FUNCTIONS

=cut

=head2 missing_files_in_isos

Returns the list of the basename of files present in $dir in $iso1,
and missing in $dir in $iso2, non-recursively.

Some was adapted from File::DirCompare:

    Copyright 2006-2007 by Gavin Carr
    This library is free software; you can redistribute it and/or modify it
    under the same terms as Perl itself.

=cut
fun missing_files_in_isos ($iso1, $iso2, $dir) {
    my $read_iso_dir = fun ($iso, $dir) {
        my $iso_obj = Device::Cdio::ISO9660::IFS->new(-source => $iso->stringify);
        map {
            Device::Cdio::ISO9660::name_translate($_->{filename});
        } $iso_obj->readdir($dir);
    };

    my @res;

    # List $dir1 and $dir2
    my (%d1, %d2);
    $d1{basename $_} = 1 foreach $read_iso_dir->($iso1, $dir);
    $d2{basename $_} = 1 foreach $read_iso_dir->($iso2, $dir);

    # Prune dot dirs
    delete $d1{''} if $d1{''};
    delete $d1{curdir()} if $d1{curdir()};
    delete $d1{updir()}  if $d1{updir()};
    delete $d2{''} if $d2{''};
    delete $d2{curdir()} if $d2{curdir()};
    delete $d2{updir()}  if $d2{updir()};

    my %u;
    for my $f (map { $u{$_}++ == 0 ? $_ : () } sort(keys(%d1), keys(%d2))) {
        push @res, $f unless $d2{$f};
    }

    return map { catfile($dir, $_) } @res;
}

=head2 upgraded_or_new_files_in_isos

Returns the list of the basename of files new or upgraded in $dir in $iso1,
wrt. $iso2, non-recursively.

Some was adapted from File::DirCompare:

    Copyright 2006-2007 by Gavin Carr
    This library is free software; you can redistribute it and/or modify it
    under the same terms as Perl itself.

=cut
fun upgraded_or_new_files_in_isos (
    AbsFile $iso1, AbsFile $iso2, $dir, $allowlist_patterns) {
    my $iso1_obj = Device::Cdio::ISO9660::IFS->new(-source => $iso1->stringify);
    my $iso2_obj = Device::Cdio::ISO9660::IFS->new(-source => $iso2->stringify);

    my $read_iso_dir = fun ($iso_obj, $dir) {
        assert(defined($iso_obj));
        my @wanted_files;
        my @files_in_dir;
        try { @files_in_dir = $iso_obj->readdir($dir) };
        foreach (@files_in_dir) {
            my $filename = Device::Cdio::ISO9660::name_translate($_->{filename});
            foreach my $re (@{$allowlist_patterns}) {
                if ($filename =~ $re) {
                    push @wanted_files, $filename;
                    last;
                }
            }
        }
        return @wanted_files;
    };

    my @res;

    # List $dir in $iso1 and $iso2
    my (%d1, %d2);
    $d1{basename $_} = 1 foreach $read_iso_dir->($iso1_obj, $dir);
    $d2{basename $_} = 1 foreach $read_iso_dir->($iso2_obj, $dir);

    # Prune dot dirs
    delete $d1{''} if $d1{''};
    delete $d1{curdir()} if $d1{curdir()};
    delete $d1{updir()}  if $d1{updir()};
    delete $d2{''} if $d2{''};
    delete $d2{curdir()} if $d2{curdir()};
    delete $d2{updir()}  if $d2{updir()};

    my %u;
    for my $f (map { $u{$_}++ == 0 ? $_ : () } sort(keys(%d1), keys(%d2))) {
        # only in $iso1
        next unless $d2{$f};

        # only in $iso2
        unless ($d1{$f}) {
            push @res, $f;
            next;
        }

        # in both
        my $stat1 = $iso1_obj->stat(catfile($dir, $f));
        my $stat2 = $iso2_obj->stat(catfile($dir, $f));

        croak "File $f in $iso1 is a directory." if $stat1->{is_dir};
        croak "File $f in $iso2 is a directory." if $stat2->{is_dir};

        push @res, $f if
            extract_file_from_iso(path($dir, $f), path($iso1))
                ne
            extract_file_from_iso(path($dir, $f), path($iso2));
    }

    return map { path($dir, $_)->basename } @res;
}


=head1 METHODS

=cut

method _build_ignore_if_same_content () { []; }
method _build_tempdir () { Path::Tiny->tempdir; }
method _build_squashfs_src_dir () {
    my $squashfs_src_dir = $self->tempdir->child('squashfs_src');
    $squashfs_src_dir->mkpath;
    return $squashfs_src_dir;
}
method _build_overlay_dir () {
    my $overlay_dir = $self->squashfs_src_dir->child('overlay');
    $overlay_dir->mkpath;
    return $overlay_dir;
}
method _build_format_version () { "2"; }
method _build_gensquashfs_options () { [
    qw{--keep-xattr --quiet},
]}

method _build_gensquashfs_prefix_cmd () { [
    ("SOURCE_DATE_EPOCH=$ENV{SOURCE_DATE_EPOCH}"),
    (
        $self->has_gensquashfs_lock_file
            ? ('flock', '--verbose', $self->gensquashfs_lock_file)
            : (),
    )
]}

method _build_delete_files () {
    my $old_iso_obj = Device::Cdio::ISO9660::IFS->new(-source=>$self->old_iso->stringify);
    my $new_iso_obj = Device::Cdio::ISO9660::IFS->new(-source=>$self->new_iso->stringify);
    my @delete_files;
    for ('EFI',
         'EFI/BOOT',
         'EFI/BOOT/grub',
         'EFI/BOOT/grub/i386-efi',
         'EFI/BOOT/grub/x86_64-efi',
         'EFI/debian',
         'EFI/debian/grub',
         'EFI/debian/grub/i386-efi',
         'EFI/debian/grub/x86_64-efi',
         qw{isolinux live syslinux tails},
         qw{utils utils/mbr utils/linux}) {
        push @delete_files,
            missing_files_in_isos($self->old_iso, $self->new_iso, $_);
    }
    return \@delete_files;
}

method _build_new_kernels () {
    my @new_kernels =
        upgraded_or_new_files_in_isos(
            $self->old_iso,
            $self->new_iso,
            'live',
            [
                qr{^ vmlinuz [[:digit:]]* $}xms,
                qr{^ initrd  [[:digit:]]* [.] img $}xms,
            ],
        );
    return \@new_kernels;
}

method create_squashfs_diff () {
    my $tempdir = $self->tempdir;

    my $old_iso_mount      = $tempdir->child('old_iso');
    my $new_iso_mount      = $tempdir->child('new_iso');
    my $old_squashfs_mount = $tempdir->child('old_squashfs');
    my $new_squashfs_mount = $tempdir->child('new_squashfs');
    my $tmpfs;
    # overlayfs requires:
    # + a workdir to become mounted
    # + workdir and upperdir to reside under the same mount
    # + workdir and upperdir to be in separate directories
    my $union_basedir      = $tempdir->child('union');
    my $union_mount        = $union_basedir->child('mount');
    my $union_workdir      = $union_basedir->child('work');
    my $union_upperdir     = $union_basedir->child('rw');

    for my $dir (
        $old_iso_mount, $new_iso_mount, $old_squashfs_mount,
        $new_squashfs_mount, $union_basedir ) {
        $dir->mkpath;
    }
    run_as_root(qw{mount -t tmpfs tmpfs}, $union_basedir);
    for my $dir ($union_mount, $union_workdir, $union_upperdir) {
        $dir->mkpath;
    }

    run_as_root("mount", "-o", "loop,ro", $self->old_iso, $old_iso_mount);
    my $old_squashfs = path($old_iso_mount, 'live', 'filesystem.squashfs');
    croak "SquashFS '$old_squashfs' not found in '$old_iso_mount'" unless -e $old_squashfs;
    run_as_root(qw{mount -t squashfs -o loop}, $old_squashfs, $old_squashfs_mount);

    run_as_root("mount", "-o", "loop,ro", $self->new_iso, $new_iso_mount);
    my $new_squashfs = path($new_iso_mount, 'live', 'filesystem.squashfs');
    croak "SquashFS '$new_squashfs' not found in '$new_iso_mount'" unless -e $new_squashfs;
    run_as_root(qw{mount -t squashfs -o loop}, $new_squashfs, $new_squashfs_mount);

    run_as_root(
        qw{mount -t overlay},
        "-o", sprintf("lowerdir=%s,upperdir=%s,workdir=%s",
                      $old_squashfs_mount, $union_upperdir, $union_workdir),
        "overlay", $union_mount
    );

    my @rsync_options = qw{--archive --quiet --delete-after --acls --checksum
                           --xattrs};

    my $t1 = time;
    run_as_root(
        "rsync", @rsync_options,
        sprintf("%s/", $new_squashfs_mount),
        sprintf("%s/", $union_mount),
    );
    printf "TIME (rsync for %s): %d seconds\n",
        $self->squashfs_diff_name,
        (time - $t1);

    for my $glob (@{$self->ignore_if_same_content}) {
        my @candidates_for_removal = map {
            path($_)
        } grep { -e } glob("$union_upperdir/$glob");

        map {
            unlink $_;
        } grep {
            my $candidate     = $_;
            my $candidate_rel = "$candidate";
            $candidate_rel    =~ s{^$union_upperdir/}{}xms;
            my $candidate_old = $old_squashfs_mount->child($candidate_rel);
            -e $candidate_old && $candidate_old->slurp eq $candidate->slurp;
        } @candidates_for_removal;
    }

    run_as_root("umount", $union_mount);

    # This code is only used by the RM from a Git checkout (in which
    # case the script is in "bin"), or when running the test suite (in
    # which case the script is in a temporary build "script"
    # directory). Let's pick the first one that we can find.
    my $tails_remove_matching_xattrs = first {
        $_->exists
    } map {
        path(__FILE__)->parent->parent->parent
                      ->child($_, 'tails-remove-matching-xattrs')
                      ->absolute
    } ('bin', 'script');
    assert(defined $tails_remove_matching_xattrs);
    run_as_root(
        $tails_remove_matching_xattrs,
        '--directory', $union_upperdir,
        '--prefix', 'trusted.overlay.',
    );

    $t1 = time;
    run_as_root(
        $self->list_gensquashfs_prefix_cmd,
        qw{gensquashfs},
        $self->list_gensquashfs_options,
        '--comp-extra', 'x86,dictsize=1024K',
        '--block-size', '1048576',
        '--pack-dir', $union_upperdir,
        $self->overlay_dir->child('live', $self->squashfs_diff_name),
    );
    assert(-e $self->overlay_dir->child('live', $self->squashfs_diff_name));
    printf "TIME (main gensquashfs for %s): %d seconds\n",
        $self->squashfs_diff_name,
        (time - $t1);

    foreach ($union_basedir,
             $new_squashfs_mount, $new_iso_mount,
             $old_squashfs_mount, $old_iso_mount) {
        run_as_root("umount", $_);
    }

    return;
}

method prepare_overlay_dir () {
    $self->overlay_dir->child('live')->mkpath;

    $self->create_squashfs_diff;

    chdir $self->overlay_dir;
    for my $new_kernel (@{$self->new_kernels}) {
        extract_here_file_from_iso(path('live', $new_kernel), $self->new_iso);
    }
    extract_here_file_from_iso('EFI',      $self->new_iso);
    extract_here_file_from_iso('isolinux', $self->new_iso);
    extract_here_file_from_iso('utils',    $self->new_iso);
    run_as_root(qw{chmod -R go+rX .});

    rename 'isolinux', 'syslinux';
    rename 'syslinux/isolinux.cfg', 'syslinux/syslinux.cfg';

    foreach my $file (glob('syslinux/*')) {
        path($file)->edit_lines(sub { s{/isolinux/}{/syslinux/}gxms });
    }

    chdir $self->tempdir;  # allow temp dirs cleanup
}

method saveas ($outfile_name) {
    $self->squashfs_src_dir->child('FORMAT')->spew($self->format_version);

    $self->squashfs_src_dir->child('control.yml')->spew(YAML::Any::Dump({
        delete_files => $self->delete_files,
    }));

    $self->prepare_overlay_dir;

    my $t1 = time;
    run_as_root(
        $self->list_gensquashfs_prefix_cmd,
        qw{gensquashfs},
        $self->list_gensquashfs_options,
        '--all-root',
        '--pack-dir', $self->squashfs_src_dir,
        $outfile_name,
    );
    printf "TIME (final gensquashfs for %s): %d seconds\n",
        path($outfile_name)->basename,
        (time - $t1);

    return;
}

method save () {
    $self->saveas($self->outfile);
}

method delete_tempdir () {
    chdir '/';
    run_as_root(qw{rm -rf}, $self->tempdir);
}

method run () {
    assert_exists(
        \%ENV, 'SOURCE_DATE_EPOCH', q{SOURCE_DATE_EPOCH is in the environment}
    );
    assert_nonblank(
        $ENV{SOURCE_DATE_EPOCH}, q{SOURCE_DATE_EPOCH variable is not empty}
    );
    $self->save;
    $self->delete_tempdir;
}

no Moo;
1;
