(() => {
  const marker = 'ygManagedAccountsV1';
  if (localStorage.getItem(marker) === '1') return;
  localStorage.removeItem('ygTeacherToken');
  localStorage.removeItem('ygStudentToken');
  localStorage.removeItem('ygAdminToken');
  sessionStorage.removeItem('ygAutoTeacher');
  sessionStorage.removeItem('ygAutoResume');
  localStorage.setItem(marker, '1');
})();
