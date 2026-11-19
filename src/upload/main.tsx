import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import UploadPage from './UploadPage.tsx';
import '../index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UploadPage />
  </StrictMode>,
);
