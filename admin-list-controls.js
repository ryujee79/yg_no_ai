(() => {
  let scheduled = false;

  function enhanceAdminLists() {
    document.querySelectorAll('.v3-delete-teacher, .v3-delete-student').forEach((button) => {
      if (button.textContent.trim() !== '개별 삭제') button.textContent = '개별 삭제';
      button.style.whiteSpace = 'nowrap';
      button.style.minWidth = '82px';
      button.style.padding = '8px 12px';
      button.setAttribute('title', '이 계정만 삭제');
    });

    document.querySelectorAll('section.card').forEach((section) => {
      const title = section.querySelector('.section-head h3')?.textContent?.trim();
      if (title !== '교사 목록' && title !== '학생 목록') return;
      const table = section.querySelector('table');
      if (!table) return;
      const headers = table.querySelectorAll('thead th');
      const last = headers[headers.length - 1];
      if (last && last.textContent.trim() !== '관리') last.textContent = '관리';
      table.querySelectorAll('tbody td:last-child').forEach((cell) => {
        cell.style.textAlign = 'center';
        cell.style.width = '110px';
      });
    });
  }

  function scheduleEnhance() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhanceAdminLists();
    });
  }

  const observer = new MutationObserver(scheduleEnhance);
  observer.observe(document.body, { childList: true, subtree: true });
  enhanceAdminLists();
})();
